//! The companion server (ADR 0005 decision 6): WebTransport on the LAN and,
//! when one is set up, the relay, both carrying the same sessions. Every
//! session runs the same steps:
//!
//! 1. the phone's init frame (protocol version, mode, id) and first handshake
//!    message; the pairing or the paired phone it names must exist;
//! 2. the laptop's reply;
//! 3. the phone's first sealed message, which proves the pairing secret
//!    (`psk2`); only then does the window hear of the phone ([`Event::Handshake`]),
//!    with the six digits and that message (the phone's hello);
//! 4. sealed application messages both ways until either side closes.
//!
//! What a session may do (pending **Allow**, view only, view and edit) is the
//! window's business: this layer only authenticates, encrypts and limits.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::{SinkExt as _, StreamExt as _};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use wtransport::tls::{Certificate as WtCertificate, CertificateChain, PrivateKey};
use wtransport::{Endpoint, Identity, ServerConfig};

use crate::cert::Certificate;
use crate::noise::Responder;
use crate::pairing::{MAX_ATTEMPTS, Registry};
use crate::wire::{self, Decoder, Frame, InitHeader, Kind, Mode, Refusal};

/// The WebTransport path phones connect to.
pub const PATH: &str = "/triage/v1";
/// Largest application message a phone may send, bytes.
pub const MAX_INBOUND_MESSAGE: usize = 1 << 20;
/// Sessions at once.
pub const MAX_SESSIONS: usize = 8;
/// Sealed frames a phone may send per second, sustained (twice that in a burst).
pub const MAX_INBOUND_RATE: f64 = 200.0;
/// Time for a phone's init frame after it connects directly.
pub const INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Time for the phone's first sealed message after the reply.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the relay client pings while connected.
pub const RELAY_PING: Duration = Duration::from_secs(25);
/// Application messages queued for one phone before [`Companion::send`] says no.
pub const OUTBOUND_QUEUE: usize = 64;

/// How a session reached the laptop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// WebTransport on the LAN.
    Lan,
    /// Through the relay.
    Relay,
}

impl Route {
    /// The name events use.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Lan => "lan",
            Self::Relay => "relay",
        }
    }
}

/// What the server tells the window.
#[derive(Clone, Debug)]
pub enum Event {
    /// A phone finished the handshake and proved its secret; `hello` is its first message.
    Handshake {
        /// The session's number.
        session: u32,
        /// Pair, reconnect or typed code.
        mode: Mode,
        /// The pairing id, the phone's mailbox or the code's mailbox.
        id: [u8; 16],
        /// The phone's static key (zero for a typed code: it sends its key in the hello).
        phone_key: [u8; 32],
        /// The six digits both screens show.
        sas: String,
        /// LAN or relay.
        route: Route,
        /// The phone's address (LAN) or "relay".
        remote: String,
        /// The phone's first application message.
        hello: Vec<u8>,
    },
    /// An application message from a phone.
    Message {
        /// The session's number.
        session: u32,
        /// The message.
        data: Vec<u8>,
    },
    /// A session ended.
    Closed {
        /// The session's number.
        session: u32,
        /// Why, in words.
        reason: String,
    },
    /// A handshake on a pairing failed.
    Failed {
        /// The pairing.
        id: [u8; 16],
        /// Pair or typed code.
        mode: Mode,
        /// Why.
        refusal: Refusal,
        /// Failed attempts so far.
        attempts: u8,
    },
    /// The relay connection for a mailbox came up or went down.
    Relay {
        /// The mailbox.
        mailbox: [u8; 16],
        /// Connected now.
        connected: bool,
        /// Why it isn't.
        error: Option<String>,
    },
}

enum Command {
    Send(Vec<u8>),
    Close(Refusal, String),
}

struct Shared {
    registry: Mutex<Registry>,
    static_private: Mutex<[u8; 32]>,
    sessions: Mutex<HashMap<u32, mpsc::Sender<Command>>>,
    origins: Mutex<Vec<String>>,
    events: mpsc::UnboundedSender<Event>,
    next_session: AtomicU32,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Shared {
    fn emit(&self, event: Event) {
        // The receiver is gone only while shutting down.
        let _ = self.events.send(event);
    }
}

struct Listener {
    endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>,
    task: JoinHandle<()>,
    port: u16,
    dual_stack: bool,
}

/// The relay URL and one connection task per mailbox.
type RelayTasks = (Option<String>, HashMap<[u8; 16], JoinHandle<()>>);

/// The companion server: start it, then read [`Companion::next_event`] in a loop.
pub struct Companion {
    shared: Arc<Shared>,
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<Event>>,
    listener: Mutex<Option<Listener>>,
    relay: Mutex<RelayTasks>,
}

/// Why the server couldn't listen.
#[derive(Debug)]
pub struct ListenError(pub String);

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ListenError {}

fn identity(certificate: &Certificate) -> Result<Identity, ListenError> {
    let der =
        WtCertificate::from_der(certificate.der.clone()).map_err(|e| ListenError(e.to_string()))?;
    Ok(Identity::new(
        CertificateChain::single(der),
        PrivateKey::from_der_pkcs8(certificate.key_der.clone()),
    ))
}

/// Dual-stack (IPv6 and IPv4) where the machine has IPv6, else IPv4 only.
fn server_config(
    port: u16,
    certificate: &Certificate,
    dual_stack: bool,
) -> Result<ServerConfig, ListenError> {
    let builder = ServerConfig::builder();
    let builder = if dual_stack {
        builder.with_bind_default(port)
    } else {
        builder.with_bind_address(SocketAddr::new(
            std::net::Ipv4Addr::UNSPECIFIED.into(),
            port,
        ))
    };
    Ok(builder
        .with_identity(identity(certificate)?)
        .keep_alive_interval(Some(Duration::from_secs(4)))
        .max_idle_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| ListenError(e.to_string()))?
        .build())
}

impl Companion {
    /// A server with the laptop's static X25519 private key. Nothing listens yet.
    #[must_use]
    pub fn new(static_private: [u8; 32]) -> Self {
        // rustls needs one crypto provider; ring is the one built in. Installing
        // twice (a second server in a process) is harmless.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (events, receiver) = mpsc::unbounded_channel();
        Self {
            shared: Arc::new(Shared {
                registry: Mutex::new(Registry::default()),
                static_private: Mutex::new(static_private),
                sessions: Mutex::new(HashMap::new()),
                origins: Mutex::new(Vec::new()),
                events,
                next_session: AtomicU32::new(1),
            }),
            events: tokio::sync::Mutex::new(receiver),
            listener: Mutex::new(None),
            relay: Mutex::new((None, HashMap::new())),
        }
    }

    /// Listens for WebTransport on `port` (UDP, IPv6 and IPv4; 0 picks one)
    /// with `certificate`; returns the port. Call from inside a Tokio runtime.
    ///
    /// # Errors
    /// A port in use, a bad certificate.
    pub fn listen(&self, port: u16, certificate: &Certificate) -> Result<u16, ListenError> {
        self.stop_listening();
        let (endpoint, dual_stack) = match Endpoint::server(server_config(port, certificate, true)?)
        {
            Ok(endpoint) => (endpoint, true),
            // No IPv6 on this machine.
            Err(_) => (
                Endpoint::server(server_config(port, certificate, false)?)
                    .map_err(|e| ListenError(e.to_string()))?,
                false,
            ),
        };
        let endpoint = Arc::new(endpoint);
        let port = endpoint
            .local_addr()
            .map_err(|e| ListenError(e.to_string()))?
            .port();
        let shared = Arc::clone(&self.shared);
        let accepting = Arc::clone(&endpoint);
        let task = tokio::spawn(async move { accept_loop(shared, accepting).await });
        *lock(&self.listener) = Some(Listener {
            endpoint,
            task,
            port,
            dual_stack,
        });
        Ok(port)
    }

    /// Serves another certificate from now on (renewal), on the same port.
    ///
    /// # Errors
    /// A bad certificate, or not listening.
    pub fn set_certificate(&self, certificate: &Certificate) -> Result<(), ListenError> {
        let guard = lock(&self.listener);
        let listener = guard
            .as_ref()
            .ok_or_else(|| ListenError("not listening".into()))?;
        listener
            .endpoint
            .reload_config(
                server_config(listener.port, certificate, listener.dual_stack)?,
                false,
            )
            .map_err(|e| ListenError(e.to_string()))
    }

    /// Stops listening on the LAN (sessions already open go on).
    pub fn stop_listening(&self) {
        if let Some(listener) = lock(&self.listener).take() {
            listener.task.abort();
            listener.endpoint.close(0u32.into(), b"stopped");
        }
    }

    /// The port it listens on.
    #[must_use]
    pub fn port(&self) -> Option<u16> {
        lock(&self.listener).as_ref().map(|l| l.port)
    }

    /// Replaces the laptop's static key (only sessions that start later use it).
    pub fn set_static_key(&self, private: [u8; 32]) {
        *lock(&self.shared.static_private) = private;
    }

    /// Origins (`https://…`) whose pages may connect on the LAN; empty allows any.
    pub fn set_allowed_origins(&self, origins: Vec<String>) {
        *lock(&self.shared.origins) = origins;
    }

    /// Opens a pairing ([`Registry::add_pairing`]).
    pub fn add_pairing(&self, id: [u8; 16], mode: Mode, psk: [u8; 32], expires_ms: i64) {
        lock(&self.shared.registry).add_pairing(id, mode, psk, expires_ms);
    }

    /// Closes a pairing.
    pub fn remove_pairing(&self, id: &[u8; 16]) {
        lock(&self.shared.registry).remove_pairing(id);
    }

    /// Marks a pairing used (its phone was allowed).
    pub fn consume_pairing(&self, id: &[u8; 16]) {
        lock(&self.shared.registry).consume(id);
    }

    /// Counts a failed attempt on a pairing (**Deny**); returns the count.
    pub fn fail_pairing(&self, id: &[u8; 16]) -> u8 {
        lock(&self.shared.registry).fail(id)
    }

    /// Replaces the paired phones (mailbox → key).
    pub fn set_phones(&self, phones: Vec<([u8; 16], [u8; 32])>) {
        lock(&self.shared.registry).set_phones(phones);
    }

    /// Queues a message for a phone; `false` when its queue is full (drop a
    /// frame, or wait with [`Companion::send_wait`]) or the session is gone.
    #[must_use]
    pub fn send(&self, session: u32, data: Vec<u8>) -> bool {
        let sender = lock(&self.shared.sessions).get(&session).cloned();
        sender.is_some_and(|s| s.try_send(Command::Send(data)).is_ok())
    }

    /// Queues a message for a phone, waiting while its queue is full.
    pub async fn send_wait(&self, session: u32, data: Vec<u8>) -> bool {
        let sender = lock(&self.shared.sessions).get(&session).cloned();
        match sender {
            Some(sender) => sender.send(Command::Send(data)).await.is_ok(),
            None => false,
        }
    }

    /// Closes a session, telling the phone why.
    pub fn close(&self, session: u32, refusal: Refusal, text: &str) {
        let sender = lock(&self.shared.sessions).get(&session).cloned();
        if let Some(sender) = sender {
            let text = text.to_string();
            tokio::spawn(async move {
                let _ = sender.send(Command::Close(refusal, text)).await;
            });
        }
    }

    /// Sessions open now.
    #[must_use]
    pub fn sessions(&self) -> usize {
        lock(&self.shared.sessions).len()
    }

    /// Keeps one relay connection per mailbox at `url` (`wss://host/…`); `None`
    /// closes them. Mailboxes no longer listed close, except a busy one, which
    /// ends with its session.
    pub fn set_relay(&self, url: Option<String>, mailboxes: &[[u8; 16]]) {
        let mut relay = lock(&self.relay);
        if relay.0 != url {
            for (_, task) in relay.1.drain() {
                task.abort();
            }
            relay.0.clone_from(&url);
        }
        let Some(url) = url else { return };
        relay.1.retain(|mailbox, task| {
            let keep = mailboxes.contains(mailbox) && !task.is_finished();
            if !keep {
                task.abort();
            }
            keep
        });
        for mailbox in mailboxes {
            if !relay.1.contains_key(mailbox) {
                let shared = Arc::clone(&self.shared);
                let url = url.clone();
                let mailbox = *mailbox;
                relay.1.insert(
                    mailbox,
                    tokio::spawn(async move { relay_loop(shared, url, mailbox).await }),
                );
            }
        }
    }

    /// The next event; `None` once the server is dropped.
    pub async fn next_event(&self) -> Option<Event> {
        self.events.lock().await.recv().await
    }

    /// Stops everything: listening, the relay and every session.
    pub fn shutdown(&self) {
        self.stop_listening();
        self.set_relay(None, &[]);
        let sessions: Vec<u32> = lock(&self.shared.sessions).keys().copied().collect();
        for session in sessions {
            self.close(session, Refusal::Closed, "the laptop stopped sharing");
        }
    }
}

impl Drop for Companion {
    fn drop(&mut self) {
        self.stop_listening();
        for (_, task) in lock(&self.relay).1.drain() {
            task.abort();
        }
    }
}

// ---- LAN ---------------------------------------------------------------------------------

async fn accept_loop(
    shared: Arc<Shared>,
    endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>,
) {
    loop {
        let incoming = endpoint.accept().await;
        let shared = Arc::clone(&shared);
        tokio::spawn(async move {
            let Ok(request) = incoming.await else { return };
            if request.path() != PATH {
                request.not_found().await;
                return;
            }
            let allowed = lock(&shared.origins).clone();
            if !allowed.is_empty()
                && !request
                    .origin()
                    .is_some_and(|o| allowed.iter().any(|a| a == o))
            {
                request.forbidden().await;
                return;
            }
            if lock(&shared.sessions).len() >= MAX_SESSIONS {
                request.too_many_requests().await;
                return;
            }
            let remote = request.remote_address();
            let Ok(connection) = request.accept().await else {
                return;
            };
            let Ok(Ok((mut send, mut recv))) =
                tokio::time::timeout(INIT_TIMEOUT, connection.accept_bi()).await
            else {
                connection.close(0u32.into(), b"no stream");
                return;
            };
            let (inbound_tx, inbound_rx) = mpsc::channel::<Result<Frame, wire::WireError>>(64);
            let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
            let reader = tokio::spawn(async move {
                let mut decoder = Decoder::default();
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    match recv.read(&mut buffer).await {
                        Ok(Some(n)) => match decoder.push(&buffer[..n]) {
                            Ok(frames) => {
                                for frame in frames {
                                    if inbound_tx.send(Ok(frame)).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(error) => {
                                let _ = inbound_tx.send(Err(error)).await;
                                return;
                            }
                        },
                        Ok(None) | Err(_) => return,
                    }
                }
            });
            let writer = tokio::spawn(async move {
                while let Some(frame) = outbound_rx.recv().await {
                    if send.write_all(&frame).await.is_err() {
                        return;
                    }
                }
                let _ = send.finish().await;
            });
            run_session(
                &shared,
                inbound_rx,
                outbound_tx,
                Route::Lan,
                remote.to_string(),
                Some(INIT_TIMEOUT),
            )
            .await;
            // Let the last frame (a refusal) go out before closing.
            let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
            reader.abort();
            connection.close(0u32.into(), b"closed");
        });
    }
}

// ---- Relay -------------------------------------------------------------------------------

async fn relay_loop(shared: Arc<Shared>, url: String, mailbox: [u8; 16]) {
    let mut backoff = Duration::from_secs(1);
    let target = format!(
        "{}/v1/{}?role=laptop",
        url.trim_end_matches('/'),
        hex::encode(mailbox)
    );
    loop {
        match tokio_tungstenite::connect_async(target.as_str()).await {
            Ok((socket, _)) => {
                backoff = Duration::from_secs(1);
                shared.emit(Event::Relay {
                    mailbox,
                    connected: true,
                    error: None,
                });
                let (mut sink, mut stream) = socket.split();
                let (inbound_tx, inbound_rx) = mpsc::channel::<Result<Frame, wire::WireError>>(64);
                let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
                let reader = tokio::spawn(async move {
                    while let Some(message) = stream.next().await {
                        let frame = match message {
                            Ok(Message::Binary(bytes)) => wire::parse(&bytes),
                            Ok(Message::Close(_)) | Err(_) => return,
                            Ok(_) => continue,
                        };
                        let failed = frame.is_err();
                        if inbound_tx.send(frame).await.is_err() || failed {
                            return;
                        }
                    }
                });
                let writer = tokio::spawn(async move {
                    // Hosted relays (Cloudflare) close a silent WebSocket: ping while waiting.
                    let mut ping = tokio::time::interval(RELAY_PING);
                    ping.tick().await;
                    loop {
                        tokio::select! {
                            frame = outbound_rx.recv() => {
                                let Some(frame) = frame else { break };
                                if sink.send(Message::Binary(frame.into())).await.is_err() {
                                    return;
                                }
                            }
                            _ = ping.tick() => {
                                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    let _ = sink.close().await;
                });
                run_session(
                    &shared,
                    inbound_rx,
                    outbound_tx,
                    Route::Relay,
                    "relay".into(),
                    None,
                )
                .await;
                let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
                reader.abort();
            }
            Err(error) => {
                shared.emit(Event::Relay {
                    mailbox,
                    connected: false,
                    error: Some(error.to_string()),
                });
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_mins(1));
            }
        }
    }
}

// ---- Sessions ----------------------------------------------------------------------------

struct Ended(Refusal, String);

/// Holds a pairing busy for the session's handshake.
struct Busy<'a> {
    shared: &'a Shared,
    id: Option<[u8; 16]>,
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            lock(&self.shared.registry).end(&id);
        }
    }
}

fn fail(shared: &Shared, header: &InitHeader, refusal: Refusal) -> Ended {
    if header.mode == Mode::Reconnect {
        return Ended(refusal, String::new());
    }
    let attempts = lock(&shared.registry).fail(&header.id);
    shared.emit(Event::Failed {
        id: header.id,
        mode: header.mode,
        refusal,
        attempts,
    });
    if attempts >= MAX_ATTEMPTS {
        Ended(Refusal::TooManyAttempts, String::new())
    } else {
        Ended(refusal, String::new())
    }
}

async fn recv_frame(
    inbound: &mut mpsc::Receiver<Result<Frame, wire::WireError>>,
    wait: Option<Duration>,
) -> Result<Option<Frame>, Ended> {
    let next = match wait {
        Some(wait) => tokio::time::timeout(wait, inbound.recv())
            .await
            .map_err(|_| Ended(Refusal::Idle, "too slow".into()))?,
        None => inbound.recv().await,
    };
    match next {
        None => Ok(None),
        Some(Ok(frame)) => Ok(Some(frame)),
        Some(Err(error)) => Err(Ended(Refusal::Protocol, error.0)),
    }
}

async fn run_session(
    shared: &Arc<Shared>,
    mut inbound: mpsc::Receiver<Result<Frame, wire::WireError>>,
    outbound: mpsc::Sender<Vec<u8>>,
    route: Route,
    remote: String,
    init_timeout: Option<Duration>,
) {
    let mut session = None;
    let result = session_steps(
        shared,
        &mut inbound,
        &outbound,
        route,
        remote,
        init_timeout,
        &mut session,
    )
    .await;
    if let Err(Ended(refusal, text)) = &result {
        let _ = outbound
            .send(wire::encode(
                Kind::Refused,
                &wire::refusal_payload(*refusal, text),
            ))
            .await;
    }
    if let Some(id) = session {
        lock(&shared.sessions).remove(&id);
        let reason = match result {
            Ok(()) => "the phone closed the connection".to_string(),
            Err(Ended(refusal, text)) if text.is_empty() => refusal.name().to_string(),
            Err(Ended(refusal, text)) => format!("{}: {text}", refusal.name()),
        };
        shared.emit(Event::Closed {
            session: id,
            reason,
        });
    }
}

#[allow(clippy::too_many_lines)]
async fn session_steps(
    shared: &Arc<Shared>,
    inbound: &mut mpsc::Receiver<Result<Frame, wire::WireError>>,
    outbound: &mpsc::Sender<Vec<u8>>,
    route: Route,
    remote: String,
    init_timeout: Option<Duration>,
    session_out: &mut Option<u32>,
) -> Result<(), Ended> {
    // 1. The init frame.
    let Some(frame) = recv_frame(inbound, init_timeout).await? else {
        return Ok(());
    };
    if frame.kind != Kind::Init {
        return Err(Ended(Refusal::Protocol, "expected an init frame".into()));
    }
    let (header, message) =
        InitHeader::parse(&frame.payload).map_err(|refusal| Ended(refusal, String::new()))?;
    let mut busy = Busy { shared, id: None };
    let (psk, expected) = match header.mode {
        Mode::Pair | Mode::Code => {
            let psk = lock(&shared.registry)
                .begin(header.mode, &header.id, now_ms())
                .map_err(|r| Ended(r, String::new()))?;
            busy.id = Some(header.id);
            (Some(psk), None)
        }
        Mode::Reconnect => {
            let key = lock(&shared.registry)
                .phone(&header.id)
                .ok_or(Ended(Refusal::NotPaired, String::new()))?;
            (None, Some(key))
        }
    };
    let static_private = *lock(&shared.static_private);
    let mut responder = Responder::new(&header, &static_private, psk.as_ref())
        .map_err(|e| Ended(Refusal::Protocol, e.0))?;
    if responder.read_init(message).is_err() {
        return Err(if header.mode == Mode::Reconnect {
            Ended(Refusal::NotPaired, String::new())
        } else {
            fail(shared, &header, Refusal::HandshakeFailed)
        });
    }
    let phone_key = responder.remote_static().unwrap_or([0; 32]);
    if let Some(expected) = expected
        && expected != phone_key
    {
        return Err(Ended(Refusal::NotPaired, String::new()));
    }
    // 2. The reply.
    let reply = responder
        .write_reply(&[])
        .map_err(|e| Ended(Refusal::Protocol, e.0))?;
    outbound
        .send(wire::encode(Kind::Reply, &reply))
        .await
        .map_err(|_| Ended(Refusal::Closed, String::new()))?;
    let mut channel = responder
        .into_channel(MAX_INBOUND_MESSAGE)
        .map_err(|e| Ended(Refusal::Protocol, e.0))?;
    // 3. The phone's first sealed message proves the secret.
    let hello = loop {
        let Some(frame) = recv_frame(inbound, Some(HELLO_TIMEOUT)).await? else {
            return Ok(());
        };
        if frame.kind != Kind::Sealed {
            return Err(Ended(Refusal::Protocol, "expected a sealed frame".into()));
        }
        match channel.open(&frame.payload) {
            Ok(Some(message)) => break message,
            Ok(None) => {}
            Err(_) => return Err(fail(shared, &header, Refusal::HandshakeFailed)),
        }
    };
    let id = shared.next_session.fetch_add(1, Ordering::Relaxed);
    let (commands_tx, mut commands) = mpsc::channel::<Command>(OUTBOUND_QUEUE);
    lock(&shared.sessions).insert(id, commands_tx);
    *session_out = Some(id);
    shared.emit(Event::Handshake {
        session: id,
        mode: header.mode,
        id: header.id,
        phone_key,
        sas: channel.sas().to_string(),
        route,
        remote,
        hello,
    });
    // 4. Messages both ways, the phone's within limits.
    let mut tokens = MAX_INBOUND_RATE * 2.0;
    let mut refilled = Instant::now();
    loop {
        tokio::select! {
            frame = recv_frame(inbound, None) => {
                let Some(frame) = frame? else { return Ok(()) };
                if frame.kind != Kind::Sealed {
                    return Err(Ended(Refusal::Protocol, "expected a sealed frame".into()));
                }
                let elapsed = refilled.elapsed().as_secs_f64();
                refilled = Instant::now();
                tokens = (tokens + elapsed * MAX_INBOUND_RATE).min(MAX_INBOUND_RATE * 2.0) - 1.0;
                if tokens < 0.0 {
                    return Err(Ended(Refusal::Limits, "too many messages".into()));
                }
                match channel.open(&frame.payload) {
                    Ok(Some(data)) => shared.emit(Event::Message { session: id, data }),
                    Ok(None) => {}
                    Err(error) => return Err(Ended(Refusal::Limits, error.0)),
                }
            }
            command = commands.recv() => match command {
                Some(Command::Send(data)) => {
                    let sealed = channel.seal(&data).map_err(|e| Ended(Refusal::Protocol, e.0))?;
                    for message in sealed {
                        outbound.send(wire::encode(Kind::Sealed, &message)).await.map_err(|_| Ended(Refusal::Closed, String::new()))?;
                    }
                }
                Some(Command::Close(refusal, text)) => return Err(Ended(refusal, text)),
                None => return Err(Ended(Refusal::Closed, String::new())),
            },
        }
    }
}

/// The laptop's LAN addresses phones can try, private IPv4 first, at most three.
#[must_use]
pub fn rank_addresses(candidates: &[std::net::IpAddr], port: u16) -> Vec<SocketAddr> {
    let mut ranked: Vec<(u8, std::net::IpAddr)> = candidates
        .iter()
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast())
        .map(|ip| {
            let rank = match ip {
                std::net::IpAddr::V4(v4) if v4.is_private() => 0,
                std::net::IpAddr::V4(v4) if v4.is_link_local() => 3,
                std::net::IpAddr::V4(_) => 1,
                std::net::IpAddr::V6(v6) if (v6.segments()[0] & 0xfe00) == 0xfc00 => 2,
                std::net::IpAddr::V6(_) => 4,
            };
            (rank, *ip)
        })
        .collect();
    ranked.sort_by_key(|(rank, _)| *rank);
    ranked.dedup_by_key(|(_, ip)| *ip);
    ranked
        .into_iter()
        .filter(|(rank, _)| *rank < 4)
        .take(3)
        .map(|(_, ip)| SocketAddr::new(ip, port))
        .collect()
}

#[cfg(test)]
mod tests;
