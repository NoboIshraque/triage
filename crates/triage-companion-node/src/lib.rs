//! Node binding of the companion's laptop side (ROADMAP PC-2): the companion
//! broker (`companionBrokerMain.ts`, a utility process) runs one
//! [`CompanionServer`] and reads its events with `nextEvent()` in a loop.
//! Keys, ids and certificates cross as `Buffer`s; times as numbers (Unix ms
//! for pairings, Unix s for certificates).
//!
//! Built as `triage_companion.node` by `crates/triage-companion-node/build.mjs`.
// napi-derive expands to the FFI glue Node needs, which is unsafe code.
#![allow(unsafe_code)]
// napi passes JavaScript values by value, and numbers are f64.
#![allow(
    clippy::needless_pass_by_value,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::must_use_candidate,
    clippy::unused_async
)]

use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use triage_companion::noise::{self, Channel, Responder};
use triage_companion::wire::{InitHeader, Mode, PROTOCOL_VERSION, Refusal};
use triage_companion::{Companion, Event, cert, qr, server};

fn error(message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, message.to_string())
}

fn array<const N: usize>(buffer: &[u8], what: &str) -> Result<[u8; N]> {
    buffer
        .try_into()
        .map_err(|_| error(format!("{what} must be {N} bytes")))
}

fn mode(name: &str) -> Result<Mode> {
    match name {
        "pair" => Ok(Mode::Pair),
        "reconnect" => Ok(Mode::Reconnect),
        "code" => Ok(Mode::Code),
        _ => Err(error(format!("unknown mode {name}"))),
    }
}

fn refusal(name: &str) -> Refusal {
    (1..=11)
        .filter_map(Refusal::from_byte)
        .find(|r| r.name() == name)
        .unwrap_or(Refusal::Closed)
}

/// A certificate and its key (PKCS#8), with its validity in Unix seconds.
#[napi(object)]
pub struct CertificateJs {
    /// DER.
    pub der: Buffer,
    /// PKCS#8 DER.
    pub key_der: Buffer,
    /// Unix s.
    pub not_before: f64,
    /// Unix s.
    pub not_after: f64,
    /// SHA-256 of the DER.
    pub hash: Buffer,
}

impl From<&cert::Certificate> for CertificateJs {
    fn from(c: &cert::Certificate) -> Self {
        Self {
            der: c.der.clone().into(),
            key_der: c.key_der.clone().into(),
            not_before: c.not_before as f64,
            not_after: c.not_after as f64,
            hash: c.hash().to_vec().into(),
        }
    }
}

impl From<&CertificateJs> for cert::Certificate {
    fn from(c: &CertificateJs) -> Self {
        Self {
            der: c.der.to_vec(),
            key_der: c.key_der.to_vec(),
            not_before: c.not_before as i64,
            not_after: c.not_after as i64,
        }
    }
}

/// An X25519 key pair.
#[napi(object)]
pub struct KeypairJs {
    /// 32 bytes.
    pub private: Buffer,
    /// 32 bytes.
    pub public: Buffer,
}

/// A paired phone: its mailbox id and static public key.
#[napi(object)]
pub struct PhoneJs {
    /// 16 bytes.
    pub mailbox: Buffer,
    /// 32 bytes.
    pub key: Buffer,
}

/// What a pairing QR code holds (`triage_companion::qr::Payload`).
#[napi(object)]
pub struct QrPayloadJs {
    /// 16 bytes.
    pub id: Buffer,
    /// 32 bytes.
    pub secret: Buffer,
    /// 32 bytes.
    pub laptop_key: Buffer,
    /// 32 bytes.
    pub certificate_hash: Buffer,
    /// Unix s.
    pub expires: f64,
    /// "board", "schematic", "3d" or "sim".
    pub view: String,
    /// `192.168.1.5:47120`, `[fd00::1]:47120`.
    pub addresses: Vec<String>,
    /// `wss://…`, if a relay is set up.
    pub relay: Option<String>,
}

/// A QR code's modules: `dark` holds one byte (0 or 1) per module, row by row.
#[napi(object)]
pub struct QrModulesJs {
    /// Modules per side.
    pub width: u32,
    /// `width * width` bytes.
    pub dark: Buffer,
}

/// One event of [`CompanionServer::next_event`]; `kind` says which fields are set.
#[napi(object)]
#[derive(Default)]
pub struct EventJs {
    /// "handshake", "message", "closed", "failed" or "relay".
    pub kind: String,
    /// The session (handshake, message, closed).
    pub session: Option<u32>,
    /// "pair", "reconnect" or "code" (handshake, failed).
    pub mode: Option<String>,
    /// The pairing id or mailbox (handshake, failed, relay).
    pub id: Option<Buffer>,
    /// The phone's static key (handshake).
    pub phone_key: Option<Buffer>,
    /// The six digits (handshake).
    pub sas: Option<String>,
    /// "lan" or "relay" (handshake).
    pub route: Option<String>,
    /// The phone's address (handshake).
    pub remote: Option<String>,
    /// The hello (handshake) or the message (message).
    pub data: Option<Buffer>,
    /// Why (closed, failed, relay).
    pub reason: Option<String>,
    /// Failed attempts (failed).
    pub attempts: Option<u32>,
    /// Relay connected (relay).
    pub connected: Option<bool>,
}

fn event_js(event: Event) -> EventJs {
    match event {
        Event::Handshake {
            session,
            mode,
            id,
            phone_key,
            sas,
            route,
            remote,
            hello,
        } => EventJs {
            kind: "handshake".into(),
            session: Some(session),
            mode: Some(mode.name().into()),
            id: Some(id.to_vec().into()),
            phone_key: Some(phone_key.to_vec().into()),
            sas: Some(sas),
            route: Some(route.name().into()),
            remote: Some(remote),
            data: Some(hello.into()),
            ..EventJs::default()
        },
        Event::Message { session, data } => EventJs {
            kind: "message".into(),
            session: Some(session),
            data: Some(data.into()),
            ..EventJs::default()
        },
        Event::Closed { session, reason } => EventJs {
            kind: "closed".into(),
            session: Some(session),
            reason: Some(reason),
            ..EventJs::default()
        },
        Event::Failed {
            id,
            mode,
            refusal,
            attempts,
        } => EventJs {
            kind: "failed".into(),
            id: Some(id.to_vec().into()),
            mode: Some(mode.name().into()),
            reason: Some(refusal.name().into()),
            attempts: Some(u32::from(attempts)),
            ..EventJs::default()
        },
        Event::Relay {
            mailbox,
            connected,
            error,
        } => EventJs {
            kind: "relay".into(),
            id: Some(mailbox.to_vec().into()),
            connected: Some(connected),
            reason: error,
            ..EventJs::default()
        },
    }
}

/// The companion server ([`triage_companion::Companion`]).
#[napi]
pub struct CompanionServer {
    inner: Arc<Companion>,
}

#[napi]
impl CompanionServer {
    /// A server with the laptop's static private key (32 bytes). Nothing listens yet.
    ///
    /// # Errors
    /// A key of the wrong size.
    #[napi(constructor)]
    pub fn new(static_private: Buffer) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(Companion::new(array::<32>(
                &static_private,
                "the static key",
            )?)),
        })
    }

    /// Listens for WebTransport on `port` (0 picks one); resolves with the port.
    ///
    /// # Errors
    /// A port in use or a bad certificate.
    #[napi]
    pub async fn listen(&self, port: u32, certificate: CertificateJs) -> Result<u32> {
        let port = u16::try_from(port).map_err(|_| error("port out of range"))?;
        self.inner
            .listen(port, &(&certificate).into())
            .map(u32::from)
            .map_err(error)
    }

    /// Serves another certificate (renewal).
    ///
    /// # Errors
    /// Not listening, or a bad certificate.
    #[napi]
    pub async fn set_certificate(&self, certificate: CertificateJs) -> Result<()> {
        self.inner
            .set_certificate(&(&certificate).into())
            .map_err(error)
    }

    /// Stops listening on the LAN.
    #[napi]
    pub fn stop_listening(&self) {
        self.inner.stop_listening();
    }

    /// The port it listens on, if it does.
    #[napi]
    pub fn port(&self) -> Option<u32> {
        self.inner.port().map(u32::from)
    }

    /// Replaces the laptop's static key.
    ///
    /// # Errors
    /// A key of the wrong size.
    #[napi]
    pub fn set_static_key(&self, private: Buffer) -> Result<()> {
        self.inner
            .set_static_key(array::<32>(&private, "the static key")?);
        Ok(())
    }

    /// Origins whose pages may connect on the LAN; empty allows any.
    #[napi]
    pub fn set_allowed_origins(&self, origins: Vec<String>) {
        self.inner.set_allowed_origins(origins);
    }

    /// Opens a pairing: id (16 bytes), "pair" or "code", PSK (32 bytes), expiry (Unix ms).
    ///
    /// # Errors
    /// Wrong sizes or mode.
    #[napi]
    pub fn add_pairing(
        &self,
        id: Buffer,
        mode_name: String,
        psk: Buffer,
        expires_ms: f64,
    ) -> Result<()> {
        self.inner.add_pairing(
            array::<16>(&id, "the pairing id")?,
            mode(&mode_name)?,
            array::<32>(&psk, "the PSK")?,
            expires_ms as i64,
        );
        Ok(())
    }

    /// Closes a pairing.
    ///
    /// # Errors
    /// A wrong id size.
    #[napi]
    pub fn remove_pairing(&self, id: Buffer) -> Result<()> {
        self.inner
            .remove_pairing(&array::<16>(&id, "the pairing id")?);
        Ok(())
    }

    /// Marks a pairing used (its phone was allowed).
    ///
    /// # Errors
    /// A wrong id size.
    #[napi]
    pub fn consume_pairing(&self, id: Buffer) -> Result<()> {
        self.inner
            .consume_pairing(&array::<16>(&id, "the pairing id")?);
        Ok(())
    }

    /// Counts a failed attempt (**Deny**); returns the count.
    ///
    /// # Errors
    /// A wrong id size.
    #[napi]
    pub fn fail_pairing(&self, id: Buffer) -> Result<u32> {
        Ok(u32::from(
            self.inner
                .fail_pairing(&array::<16>(&id, "the pairing id")?),
        ))
    }

    /// Replaces the paired phones.
    ///
    /// # Errors
    /// Wrong sizes.
    #[napi]
    pub fn set_phones(&self, phones: Vec<PhoneJs>) -> Result<()> {
        let phones = phones
            .iter()
            .map(|p| {
                Ok((
                    array::<16>(&p.mailbox, "a mailbox")?,
                    array::<32>(&p.key, "a phone key")?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        self.inner.set_phones(phones);
        Ok(())
    }

    /// Queues a message for a phone; `false` if its queue is full or it's gone.
    #[napi]
    pub fn send(&self, session: u32, data: Buffer) -> bool {
        self.inner.send(session, data.to_vec())
    }

    /// Queues a message for a phone, waiting while its queue is full.
    #[napi]
    pub async fn send_wait(&self, session: u32, data: Buffer) -> bool {
        self.inner.send_wait(session, data.to_vec()).await
    }

    /// Closes a session; `refusal` is one of the wire refusals' names ("closed", "denied" …).
    #[napi]
    pub async fn close(&self, session: u32, refusal_name: String, text: String) {
        self.inner.close(session, refusal(&refusal_name), &text);
    }

    /// Sessions open now.
    #[napi]
    pub fn sessions(&self) -> u32 {
        u32::try_from(self.inner.sessions()).unwrap_or(u32::MAX)
    }

    /// Keeps one relay connection per mailbox (16 bytes each); `null` closes them.
    ///
    /// # Errors
    /// A wrong mailbox size.
    #[napi]
    pub async fn set_relay(&self, url: Option<String>, mailboxes: Vec<Buffer>) -> Result<()> {
        let mailboxes = mailboxes
            .iter()
            .map(|m| array::<16>(m, "a mailbox"))
            .collect::<Result<Vec<_>>>()?;
        self.inner.set_relay(url, &mailboxes);
        Ok(())
    }

    /// The next event; `null` once the server is gone.
    #[napi]
    pub async fn next_event(&self) -> Option<EventJs> {
        let inner = Arc::clone(&self.inner);
        inner.next_event().await.map(event_js)
    }

    /// Stops listening, the relay and every session.
    #[napi]
    pub async fn shutdown(&self) {
        self.inner.shutdown();
    }
}

/// A fresh X25519 key pair.
#[napi]
pub fn generate_keypair() -> KeypairJs {
    let keys = noise::generate_keypair();
    KeypairJs {
        private: keys.private.to_vec().into(),
        public: keys.public.to_vec().into(),
    }
}

/// The public key of a private key.
///
/// # Errors
/// A key of the wrong size.
#[napi]
pub fn public_key(private: Buffer) -> Result<Buffer> {
    Ok(
        noise::public_key(&array::<32>(&private, "the private key")?)
            .to_vec()
            .into(),
    )
}

/// The certificates to keep at `now` (Unix s): the served one and the next.
///
/// # Errors
/// If a certificate can't be made.
#[napi]
pub fn plan_certificates(certificates: Vec<CertificateJs>, now: f64) -> Result<Vec<CertificateJs>> {
    let planned =
        cert::plan(certificates.iter().map(Into::into).collect(), now as i64).map_err(error)?;
    Ok(planned.iter().map(Into::into).collect())
}

/// The certificate to serve at `now` from a plan.
#[napi]
pub fn current_certificate(certificates: Vec<CertificateJs>, now: f64) -> Option<CertificateJs> {
    let list: Vec<cert::Certificate> = certificates.iter().map(Into::into).collect();
    cert::current(&list, now as i64).map(Into::into)
}

/// A certificate valid from `not_before` (Unix s) for just under 14 days (tests).
///
/// # Errors
/// If it can't be made.
#[napi]
pub fn generate_certificate(not_before: f64) -> Result<CertificateJs> {
    cert::generate(not_before as i64)
        .map(|c| (&c).into())
        .map_err(error)
}

fn payload(js: &QrPayloadJs) -> Result<qr::Payload> {
    let view = qr::VIEWS
        .iter()
        .position(|v| *v == js.view)
        .ok_or_else(|| error(format!("unknown view {}", js.view)))?;
    Ok(qr::Payload {
        id: array::<16>(&js.id, "the pairing id")?,
        secret: array::<32>(&js.secret, "the secret")?,
        laptop_key: array::<32>(&js.laptop_key, "the laptop key")?,
        certificate_hash: array::<32>(&js.certificate_hash, "the certificate hash")?,
        expires: js.expires as u32,
        view: u8::try_from(view).unwrap_or(0),
        addresses: js.addresses.iter().filter_map(|a| a.parse().ok()).collect(),
        relay: js.relay.clone(),
    })
}

/// The QR code's link for a payload: `<app URL>/p#<base64url>`.
///
/// # Errors
/// Wrong sizes or an unknown view.
#[napi]
pub fn qr_link(payload_js: QrPayloadJs, app_url: String) -> Result<String> {
    Ok(payload(&payload_js)?.link(&app_url))
}

/// Reads a QR code's link (tests; the phone reads it in TypeScript).
///
/// # Errors
/// A link that doesn't parse.
#[napi]
pub fn qr_payload(link: String) -> Result<QrPayloadJs> {
    let p = qr::Payload::from_link(&link).map_err(error)?;
    Ok(QrPayloadJs {
        id: p.id.to_vec().into(),
        secret: p.secret.to_vec().into(),
        laptop_key: p.laptop_key.to_vec().into(),
        certificate_hash: p.certificate_hash.to_vec().into(),
        expires: f64::from(p.expires),
        view: qr::VIEWS[usize::from(p.view)].into(),
        addresses: p.addresses.iter().map(ToString::to_string).collect(),
        relay: p.relay,
    })
}

/// The QR code's modules for a text.
///
/// # Errors
/// A text too long for a QR code.
#[napi]
pub fn qr_modules(text: String) -> Result<QrModulesJs> {
    let (width, dark) = qr::modules(&text).map_err(error)?;
    Ok(QrModulesJs {
        width: u32::try_from(width).unwrap_or(0),
        dark: dark.into_iter().map(u8::from).collect::<Vec<_>>().into(),
    })
}

/// `n` random bytes (ids, secrets), at most 64.
#[napi]
pub fn random_bytes(n: u32) -> Buffer {
    let bytes = qr::random::<64>();
    bytes[..(n as usize).min(64)].to_vec().into()
}

/// A fresh 8-character typed code.
#[napi]
pub fn new_code() -> String {
    qr::new_code()
}

/// A typed code normalized, or `null` if it isn't one.
#[napi]
pub fn normalize_code(code: String) -> Option<String> {
    qr::normalize_code(&code)
}

/// The PSK of a normalized typed code.
#[napi]
pub fn code_psk(code: String) -> Buffer {
    noise::code_psk(&code).to_vec().into()
}

/// The relay mailbox of a normalized typed code.
#[napi]
pub fn code_mailbox(code: String) -> Buffer {
    noise::code_mailbox(&code).to_vec().into()
}

/// The LAN addresses to put in a QR code ("ip:port"), private IPv4 first.
#[napi]
pub fn rank_addresses(ips: Vec<String>, port: u32) -> Vec<String> {
    let ips: Vec<IpAddr> = ips.iter().filter_map(|ip| ip.parse().ok()).collect();
    server::rank_addresses(&ips, u16::try_from(port).unwrap_or(0))
        .iter()
        .map(ToString::to_string)
        .collect()
}

/// The protocol version the laptop speaks.
#[napi]
pub fn protocol_version() -> u32 {
    u32::from(PROTOCOL_VERSION)
}

/// The laptop's side of one handshake, for tests of the phone's Noise code.
#[napi]
pub struct TestResponder {
    responder: Mutex<Option<Responder>>,
    channel: Mutex<Option<Channel>>,
}

#[napi]
impl TestResponder {
    /// A responder for a mode ("pair", "reconnect", "code") and id; `psk` for pair and code.
    ///
    /// # Errors
    /// Wrong sizes or mode.
    #[napi(constructor)]
    pub fn new(
        mode_name: String,
        id: Buffer,
        static_private: Buffer,
        psk: Option<Buffer>,
    ) -> Result<Self> {
        let header = InitHeader {
            version: PROTOCOL_VERSION,
            mode: mode(&mode_name)?,
            id: array::<16>(&id, "the id")?,
        };
        let psk = psk.map(|p| array::<32>(&p, "the PSK")).transpose()?;
        let responder = Responder::new(
            &header,
            &array::<32>(&static_private, "the static key")?,
            psk.as_ref(),
        )
        .map_err(error)?;
        Ok(Self {
            responder: Mutex::new(Some(responder)),
            channel: Mutex::new(None),
        })
    }

    /// Reads the init message; returns its payload.
    ///
    /// # Errors
    /// A message that doesn't decrypt.
    #[napi]
    pub fn read_init(&self, message: Buffer) -> Result<Buffer> {
        let mut guard = self.responder.lock().map_err(error)?;
        let responder = guard.as_mut().ok_or_else(|| error("finished"))?;
        responder.read_init(&message).map(Into::into).map_err(error)
    }

    /// The phone's static key, after the init.
    ///
    /// # Errors
    /// A poisoned lock.
    #[napi]
    pub fn remote_static(&self) -> Result<Option<Buffer>> {
        let guard = self.responder.lock().map_err(error)?;
        Ok(guard
            .as_ref()
            .and_then(Responder::remote_static)
            .map(|k| k.to_vec().into()))
    }

    /// Writes the reply and switches to transport mode; returns the reply.
    ///
    /// # Errors
    /// Out of turn.
    #[napi]
    pub fn write_reply(&self, payload: Buffer) -> Result<Buffer> {
        let mut responder = self
            .responder
            .lock()
            .map_err(error)?
            .take()
            .ok_or_else(|| error("finished"))?;
        let reply = responder.write_reply(&payload).map_err(error)?;
        *self.channel.lock().map_err(error)? = Some(
            responder
                .into_channel(server::MAX_INBOUND_MESSAGE * 64)
                .map_err(error)?,
        );
        Ok(reply.into())
    }

    /// The six digits.
    ///
    /// # Errors
    /// Before the reply.
    #[napi]
    pub fn sas(&self) -> Result<String> {
        let guard = self.channel.lock().map_err(error)?;
        Ok(guard
            .as_ref()
            .ok_or_else(|| error("no channel yet"))?
            .sas()
            .to_string())
    }

    /// Seals a message into Noise messages.
    ///
    /// # Errors
    /// Before the reply.
    #[napi]
    pub fn seal(&self, message: Buffer) -> Result<Vec<Buffer>> {
        let mut guard = self.channel.lock().map_err(error)?;
        let channel = guard.as_mut().ok_or_else(|| error("no channel yet"))?;
        Ok(channel
            .seal(&message)
            .map_err(error)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Opens a Noise message; returns a message once complete.
    ///
    /// # Errors
    /// One that doesn't decrypt.
    #[napi]
    pub fn open(&self, sealed: Buffer) -> Result<Option<Buffer>> {
        let mut guard = self.channel.lock().map_err(error)?;
        let channel = guard.as_mut().ok_or_else(|| error("no channel yet"))?;
        Ok(channel.open(&sealed).map_err(error)?.map(Into::into))
    }
}
