//! The end-to-end Noise session between the phone app and the laptop (PLAN
//! §4.16, ADR 0005 decision 3): X25519, AES-256-GCM and SHA-256, the primitives
//! `WebCrypto` has, so the phone runs the same handshakes (`companion/noise.ts`).
//!
//! | Mode | Pattern | Phone knows | Laptop checks |
//! |---|---|---|---|
//! | pair (QR) | `Noise_IKpsk2_25519_AESGCM_SHA256` | the laptop's key and the one-time secret, from the QR | the secret (the phone's first sealed message) |
//! | reconnect | `Noise_IK_25519_AESGCM_SHA256` | the laptop's pinned key | the phone's key is a paired one |
//! | typed code | `Noise_NNpsk0_25519_AESGCM_SHA256` | the code, stretched with PBKDF2 | the code; then the six digits |
//!
//! The prologue binds the init header (version, mode, id). Both sides show six
//! digits derived from the handshake hash ([`sas`]): a phone that photographed
//! the QR on a projector gets other digits than the one in the user's hand.
//! Application messages larger than one Noise message are split into fragments
//! with a one-byte flag ([`Channel`]).

use std::fmt;

use curve25519_dalek::montgomery::MontgomeryPoint;
use sha2::{Digest as _, Sha256};
use snow::{Builder, HandshakeState, TransportState};

use crate::wire::{InitHeader, Mode, NOISE_MAX};

/// The pairing pattern.
pub const PATTERN_PAIR: &str = "Noise_IKpsk2_25519_AESGCM_SHA256";
/// The reconnect pattern.
pub const PATTERN_RECONNECT: &str = "Noise_IK_25519_AESGCM_SHA256";
/// The typed-code pattern.
pub const PATTERN_CODE: &str = "Noise_NNpsk0_25519_AESGCM_SHA256";
/// The prologue's fixed part; the init header follows it.
pub const PROLOGUE: &[u8] = b"triage-companion/1";
/// AES-GCM's tag.
pub const TAG: usize = 16;
/// Largest fragment of an application message in one Noise message.
pub const MAX_FRAGMENT: usize = NOISE_MAX - TAG - 1;
/// PBKDF2 iterations that stretch a typed code (`WhatsApp`'s linking code uses 2^17).
pub const CODE_ITERATIONS: u32 = 1 << 17;
const FLAG_MORE: u8 = 1;

/// A handshake or transport failure: the connection closes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoiseError(pub String);

impl fmt::Display for NoiseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NoiseError {}

impl From<snow::Error> for NoiseError {
    fn from(error: snow::Error) -> Self {
        Self(error.to_string())
    }
}

/// An X25519 key pair.
#[derive(Clone)]
pub struct Keypair {
    /// The private key.
    pub private: [u8; 32],
    /// Its public key.
    pub public: [u8; 32],
}

/// A fresh key pair.
#[must_use]
pub fn generate_keypair() -> Keypair {
    let private = crate::qr::random::<32>();
    Keypair {
        private,
        public: public_key(&private),
    }
}

/// The public key of an X25519 private key.
#[must_use]
pub fn public_key(private: &[u8; 32]) -> [u8; 32] {
    MontgomeryPoint::mul_base_clamped(*private).to_bytes()
}

/// The prologue both sides mix in: [`PROLOGUE`] and the init header.
#[must_use]
pub fn prologue(header: &InitHeader) -> Vec<u8> {
    let mut out = PROLOGUE.to_vec();
    out.extend_from_slice(&header.to_bytes());
    out
}

/// The six digits both screens show, from the handshake hash.
#[must_use]
pub fn sas(handshake_hash: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"triage-companion-sas/1");
    hasher.update(handshake_hash);
    let digest = hasher.finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{n:06}")
}

/// The pre-shared key of a typed code (normalized, [`crate::qr::normalize_code`]).
#[must_use]
pub fn code_psk(code: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(
        code.as_bytes(),
        b"triage-companion-code/1",
        CODE_ITERATIONS,
        &mut out,
    );
    out
}

/// The relay mailbox of a typed code.
#[must_use]
pub fn code_mailbox(code: &str) -> [u8; 16] {
    let mut hasher = Sha256::new();
    hasher.update(b"triage-companion-mailbox/1");
    hasher.update(code.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

fn pattern(mode: Mode) -> &'static str {
    match mode {
        Mode::Pair => PATTERN_PAIR,
        Mode::Reconnect => PATTERN_RECONNECT,
        Mode::Code => PATTERN_CODE,
    }
}

fn builder(mode: Mode) -> Result<Builder<'static>, NoiseError> {
    Ok(Builder::new(pattern(mode).parse()?))
}

/// The laptop's side of a handshake.
pub struct Responder {
    state: HandshakeState,
}

impl Responder {
    /// Starts a handshake for a phone's init header. `static_private` is the
    /// laptop's key (pair, reconnect); `psk` the QR's secret or the code's key.
    ///
    /// # Errors
    /// A missing key or PSK for the mode.
    pub fn new(
        header: &InitHeader,
        static_private: &[u8; 32],
        psk: Option<&[u8; 32]>,
    ) -> Result<Self, NoiseError> {
        let prologue = prologue(header);
        let mut builder = builder(header.mode)?.prologue(&prologue)?;
        if header.mode != Mode::Code {
            builder = builder.local_private_key(static_private)?;
        }
        match (header.mode, psk) {
            (Mode::Pair, Some(psk)) => builder = builder.psk(2, psk)?,
            (Mode::Code, Some(psk)) => builder = builder.psk(0, psk)?,
            (Mode::Reconnect, None) => {}
            _ => return Err(NoiseError("wrong pre-shared key for the mode".into())),
        }
        Ok(Self {
            state: builder.build_responder()?,
        })
    }

    /// Reads the phone's first message; returns its payload.
    ///
    /// # Errors
    /// A message that doesn't decrypt or parse.
    pub fn read_init(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut payload = vec![0u8; NOISE_MAX];
        let n = self.state.read_message(message, &mut payload)?;
        payload.truncate(n);
        Ok(payload)
    }

    /// The phone's static key, once [`Responder::read_init`] read it (pair, reconnect).
    #[must_use]
    pub fn remote_static(&self) -> Option<[u8; 32]> {
        let key = self.state.get_remote_static()?;
        let mut out = [0u8; 32];
        out.copy_from_slice(key.get(..32)?);
        Some(out)
    }

    /// Writes the reply (the handshake's last message).
    ///
    /// # Errors
    /// Out of turn, or a payload too large.
    pub fn write_reply(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut message = vec![0u8; NOISE_MAX];
        let n = self.state.write_message(payload, &mut message)?;
        message.truncate(n);
        Ok(message)
    }

    /// The transport channel, once the reply is written.
    ///
    /// # Errors
    /// If the handshake isn't finished.
    pub fn into_channel(self, max_message: usize) -> Result<Channel, NoiseError> {
        Channel::new(self.state, max_message)
    }
}

/// The phone's side of a handshake (tests, and a scripted phone in Rust).
pub struct Initiator {
    state: HandshakeState,
}

impl Initiator {
    /// Starts a handshake. `static_private`: the phone's key (pair, reconnect);
    /// `laptop_key`: the laptop's public key (pair, reconnect); `psk`: the QR's
    /// secret or the code's key.
    ///
    /// # Errors
    /// Missing keys for the mode.
    pub fn new(
        header: &InitHeader,
        static_private: Option<&[u8; 32]>,
        laptop_key: Option<&[u8; 32]>,
        psk: Option<&[u8; 32]>,
    ) -> Result<Self, NoiseError> {
        let prologue = prologue(header);
        let mut builder = builder(header.mode)?.prologue(&prologue)?;
        if header.mode != Mode::Code {
            let (Some(private), Some(laptop)) = (static_private, laptop_key) else {
                return Err(NoiseError(
                    "pair and reconnect need both static keys".into(),
                ));
            };
            builder = builder
                .local_private_key(private)?
                .remote_public_key(laptop)?;
        }
        match (header.mode, psk) {
            (Mode::Pair, Some(psk)) => builder = builder.psk(2, psk)?,
            (Mode::Code, Some(psk)) => builder = builder.psk(0, psk)?,
            (Mode::Reconnect, None) => {}
            _ => return Err(NoiseError("wrong pre-shared key for the mode".into())),
        }
        Ok(Self {
            state: builder.build_initiator()?,
        })
    }

    /// The first message, to send after the init header.
    ///
    /// # Errors
    /// Out of turn, or a payload too large.
    pub fn write_init(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut message = vec![0u8; NOISE_MAX];
        let n = self.state.write_message(payload, &mut message)?;
        message.truncate(n);
        Ok(message)
    }

    /// Reads the laptop's reply and returns the transport channel.
    ///
    /// # Errors
    /// A reply that doesn't decrypt: a wrong secret, or someone in between.
    pub fn read_reply(
        mut self,
        message: &[u8],
        max_message: usize,
    ) -> Result<(Vec<u8>, Channel), NoiseError> {
        let mut payload = vec![0u8; NOISE_MAX];
        let n = self.state.read_message(message, &mut payload)?;
        payload.truncate(n);
        Ok((payload, Channel::new(self.state, max_message)?))
    }
}

/// A finished handshake: seals and opens application messages.
pub struct Channel {
    transport: TransportState,
    sas: String,
    hash: Vec<u8>,
    partial: Vec<u8>,
    max_message: usize,
}

impl Channel {
    fn new(state: HandshakeState, max_message: usize) -> Result<Self, NoiseError> {
        let hash = state.get_handshake_hash().to_vec();
        let sas = sas(&hash);
        Ok(Self {
            transport: state.into_transport_mode()?,
            sas,
            hash,
            partial: Vec::new(),
            max_message,
        })
    }

    /// The six digits both screens show.
    #[must_use]
    pub fn sas(&self) -> &str {
        &self.sas
    }

    /// The handshake hash (tests compare it with the phone's).
    #[must_use]
    pub fn handshake_hash(&self) -> &[u8] {
        &self.hash
    }

    /// Seals one application message into Noise messages, one per [`crate::wire::Kind::Sealed`] frame.
    ///
    /// # Errors
    /// If Noise refuses (nonce exhausted).
    pub fn seal(&mut self, message: &[u8]) -> Result<Vec<Vec<u8>>, NoiseError> {
        let mut out = Vec::with_capacity(message.len() / MAX_FRAGMENT + 1);
        let mut pieces = message.chunks(MAX_FRAGMENT).peekable();
        let mut plain = Vec::with_capacity(MAX_FRAGMENT + 1);
        if pieces.peek().is_none() {
            plain.push(0);
            out.push(self.encrypt(&plain)?);
            return Ok(out);
        }
        while let Some(piece) = pieces.next() {
            plain.clear();
            plain.push(if pieces.peek().is_some() {
                FLAG_MORE
            } else {
                0
            });
            plain.extend_from_slice(piece);
            out.push(self.encrypt(&plain)?);
        }
        Ok(out)
    }

    fn encrypt(&mut self, plain: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let mut sealed = vec![0u8; plain.len() + TAG];
        let n = self.transport.write_message(plain, &mut sealed)?;
        sealed.truncate(n);
        Ok(sealed)
    }

    /// Opens one Noise message; returns an application message once its last fragment arrived.
    ///
    /// # Errors
    /// A message that doesn't decrypt (tampered, replayed, out of order), an
    /// empty fragment, or a message over the channel's limit.
    pub fn open(&mut self, sealed: &[u8]) -> Result<Option<Vec<u8>>, NoiseError> {
        if sealed.len() < TAG + 1 || sealed.len() > NOISE_MAX {
            return Err(NoiseError("sealed message of the wrong size".into()));
        }
        let mut plain = vec![0u8; sealed.len()];
        let n = self.transport.read_message(sealed, &mut plain)?;
        let (flags, data) = plain[..n]
            .split_first()
            .ok_or_else(|| NoiseError("empty fragment".into()))?;
        if flags & !FLAG_MORE != 0 {
            return Err(NoiseError("unknown fragment flags".into()));
        }
        if self.partial.len() + data.len() > self.max_message {
            return Err(NoiseError(format!(
                "message over {} bytes",
                self.max_message
            )));
        }
        self.partial.extend_from_slice(data);
        if flags & FLAG_MORE != 0 {
            return Ok(None);
        }
        Ok(Some(std::mem::take(&mut self.partial)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::PROTOCOL_VERSION;
    use proptest::prelude::*;

    fn header(mode: Mode) -> InitHeader {
        InitHeader {
            version: PROTOCOL_VERSION,
            mode,
            id: [7; 16],
        }
    }

    fn handshake(
        mode: Mode,
        psk_phone: Option<[u8; 32]>,
        psk_laptop: Option<[u8; 32]>,
    ) -> Result<(Channel, Channel, Option<[u8; 32]>), NoiseError> {
        let laptop = generate_keypair();
        let phone = generate_keypair();
        let h = header(mode);
        let mut initiator = Initiator::new(
            &h,
            Some(&phone.private),
            Some(&laptop.public),
            psk_phone.as_ref(),
        )?;
        let mut responder = Responder::new(&h, &laptop.private, psk_laptop.as_ref())?;
        let init = initiator.write_init(b"")?;
        responder.read_init(&init)?;
        let remote = responder.remote_static();
        let reply = responder.write_reply(b"")?;
        let (_, phone_channel) = initiator.read_reply(&reply, 1 << 20)?;
        let laptop_channel = responder.into_channel(1 << 20)?;
        Ok((phone_channel, laptop_channel, remote))
    }

    #[test]
    fn pairing_agrees_on_the_digits_and_carries_messages_both_ways() {
        let psk = [9u8; 32];
        let (mut phone, mut laptop, remote) =
            handshake(Mode::Pair, Some(psk), Some(psk)).expect("handshake");
        assert!(remote.is_some());
        assert_eq!(phone.sas(), laptop.sas());
        assert_eq!(phone.sas().len(), 6);
        let big = vec![42u8; 200_000];
        let mut received = None;
        for sealed in phone.seal(&big).expect("seal") {
            received = laptop.open(&sealed).expect("open");
        }
        assert_eq!(received.as_deref(), Some(&big[..]));
        let sealed = laptop.seal(b"").expect("seal");
        assert_eq!(
            phone.open(&sealed[0]).expect("open").as_deref(),
            Some(&b""[..])
        );
    }

    #[test]
    fn a_wrong_secret_fails_the_phones_first_sealed_message() {
        // psk2: the reply already fails on the phone when the laptop's secret differs.
        assert!(handshake(Mode::Pair, Some([1; 32]), Some([2; 32])).is_err());
    }

    #[test]
    fn reconnect_and_code_modes_work() {
        let (phone, laptop, remote) = handshake(Mode::Reconnect, None, None).expect("reconnect");
        assert!(remote.is_some());
        assert_eq!(phone.sas(), laptop.sas());
        let code = crate::qr::normalize_code("abcd-efgh").expect("code");
        let psk = code_psk(&code);
        let h = header(Mode::Code);
        let mut initiator = Initiator::new(&h, None, None, Some(&psk)).expect("initiator");
        let mut responder = Responder::new(&h, &[0; 32], Some(&psk)).expect("responder");
        responder
            .read_init(&initiator.write_init(b"").expect("init"))
            .expect("read");
        let (_, phone) = initiator
            .read_reply(&responder.write_reply(b"").expect("reply"), 1024)
            .expect("reply");
        assert_eq!(
            phone.sas(),
            responder.into_channel(1024).expect("channel").sas()
        );
        let wrong = code_psk("ABCDEFGJ");
        let mut initiator = Initiator::new(&h, None, None, Some(&wrong)).expect("initiator");
        let mut responder = Responder::new(&h, &[0; 32], Some(&psk)).expect("responder");
        assert!(
            responder
                .read_init(&initiator.write_init(b"").expect("init"))
                .is_err()
        );
    }

    #[test]
    fn tampered_replayed_and_oversized_messages_are_refused() {
        let (mut phone, mut laptop, _) =
            handshake(Mode::Pair, Some([3; 32]), Some([3; 32])).expect("handshake");
        let sealed = phone.seal(b"hello").expect("seal").remove(0);
        let mut tampered = sealed.clone();
        tampered[3] ^= 1;
        assert!(laptop.open(&tampered).is_err());
        let (mut phone, mut laptop, _) =
            handshake(Mode::Pair, Some([3; 32]), Some([3; 32])).expect("handshake");
        let sealed = phone.seal(b"hello").expect("seal").remove(0);
        assert!(laptop.open(&sealed).expect("open").is_some());
        assert!(laptop.open(&sealed).is_err(), "replay");
        let (mut phone, mut laptop, _) =
            handshake(Mode::Pair, Some([3; 32]), Some([3; 32])).expect("handshake");
        let mut failed = false;
        for sealed in phone.seal(&vec![0; (1 << 20) + 1]).expect("seal") {
            if laptop.open(&sealed).is_err() {
                failed = true;
                break;
            }
        }
        assert!(failed, "over the limit");
    }

    #[test]
    fn digits_and_code_keys_are_stable() {
        assert_eq!(sas(&[0; 32]), sas(&[0; 32]));
        assert_ne!(sas(&[0; 32]), sas(&[1; 32]));
        assert_eq!(code_mailbox("ABCDEFGH"), code_mailbox("ABCDEFGH"));
        assert_ne!(code_mailbox("ABCDEFGH"), code_mailbox("ABCDEFGJ"));
        assert_eq!(public_key(&generate_keypair().private).len(), 32);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]
        #[test]
        fn responders_survive_garbage(bytes in proptest::collection::vec(any::<u8>(), 0..200), mode in 1u8..=3) {
            let mode = Mode::from_byte(mode).expect("mode");
            let psk = (mode != Mode::Reconnect).then_some([5u8; 32]);
            let mut responder = Responder::new(&header(mode), &[1; 32], psk.as_ref()).expect("responder");
            prop_assert!(responder.read_init(&bytes).is_err() || bytes.len() >= 32);
        }
    }
}
