//! Wire frames between the phone app and the laptop (PLAN §4.16): the engine
//! connection's layout (u32 little-endian length of type + payload, u8 type,
//! payload; `engineProtocol.ts`) with the companion's own frame types. Every
//! frame but [`Kind::Init`]'s header and [`Kind::Refused`] carries Noise bytes.
//!
//! The same frames travel on a WebTransport stream (split by [`Decoder`]) and
//! as WebSocket messages through the relay (one frame per message, [`parse`]).

use std::fmt;

/// Bytes before a frame's payload: length (4) and type (1).
pub const FRAME_HEADER: usize = 5;
/// Noise's limit on one message (Noise specification §3).
pub const NOISE_MAX: usize = 65_535;
/// Largest frame body (type + payload): one Noise message and the init header.
pub const MAX_FRAME_BODY: usize = 1 + INIT_HEADER + NOISE_MAX;
/// The companion protocol's version, first byte of every [`Kind::Init`].
pub const PROTOCOL_VERSION: u8 = 1;
/// Bytes of an init header: version, mode, 16-byte id.
pub const INIT_HEADER: usize = 18;
/// Longest refusal text, bytes.
pub const MAX_REFUSAL_TEXT: usize = 200;

/// Frame types (the engine connection uses 0x01–0x12 and 0x7f).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// Phone → laptop: init header, then the first handshake message.
    Init = 0x20,
    /// Laptop → phone: the second handshake message.
    Reply = 0x21,
    /// Either way: one Noise transport message (a fragment of an application message).
    Sealed = 0x22,
    /// Laptop → phone, unencrypted, just before closing: why ([`Refusal`]).
    Refused = 0x23,
}

impl Kind {
    /// The kind of a frame's type byte.
    #[must_use]
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0x20 => Some(Self::Init),
            0x21 => Some(Self::Reply),
            0x22 => Some(Self::Sealed),
            0x23 => Some(Self::Refused),
            _ => None,
        }
    }
}

/// How a phone connects (the init header's mode byte).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Mode {
    /// First pairing from a QR code: `Noise_IKpsk2`, the QR's secret as the PSK.
    Pair = 1,
    /// A paired phone coming back: `Noise_IK` with the pinned keys.
    Reconnect = 2,
    /// Pairing with the typed 8-character code through the relay: `Noise_NNpsk0`.
    Code = 3,
}

impl Mode {
    /// The mode of an init header's mode byte.
    #[must_use]
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Pair),
            2 => Some(Self::Reconnect),
            3 => Some(Self::Code),
            _ => None,
        }
    }

    /// The name events and logs use.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Pair => "pair",
            Self::Reconnect => "reconnect",
            Self::Code => "code",
        }
    }
}

/// Why the laptop refused or closed a connection (the first byte of [`Kind::Refused`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Refusal {
    /// The phone app speaks another protocol version: it must update (or the laptop).
    Incompatible = 1,
    /// The QR code (or typed code) is unknown, expired or already used.
    Expired = 2,
    /// The phone isn't paired (or was removed): pair again.
    NotPaired = 3,
    /// Five failed attempts ended this QR code.
    TooManyAttempts = 4,
    /// Another phone is answering this QR code right now.
    Busy = 5,
    /// The person at the laptop said no.
    Denied = 6,
    /// The handshake failed (a wrong key or secret, or damaged bytes).
    HandshakeFailed = 7,
    /// The phone sent too much, too fast, or too large.
    Limits = 8,
    /// The laptop stopped sharing, or removed this phone.
    Closed = 9,
    /// The phone sent something the protocol doesn't allow.
    Protocol = 10,
    /// The phone was silent too long.
    Idle = 11,
}

impl Refusal {
    /// The refusal of a [`Kind::Refused`] frame's first byte.
    #[must_use]
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Incompatible),
            2 => Some(Self::Expired),
            3 => Some(Self::NotPaired),
            4 => Some(Self::TooManyAttempts),
            5 => Some(Self::Busy),
            6 => Some(Self::Denied),
            7 => Some(Self::HandshakeFailed),
            8 => Some(Self::Limits),
            9 => Some(Self::Closed),
            10 => Some(Self::Protocol),
            11 => Some(Self::Idle),
            _ => None,
        }
    }

    /// The name events use (`companionProtocol.ts` maps it to a sentence).
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Incompatible => "incompatible",
            Self::Expired => "expired",
            Self::NotPaired => "not-paired",
            Self::TooManyAttempts => "too-many-attempts",
            Self::Busy => "busy",
            Self::Denied => "denied",
            Self::HandshakeFailed => "handshake-failed",
            Self::Limits => "limits",
            Self::Closed => "closed",
            Self::Protocol => "protocol",
            Self::Idle => "idle",
        }
    }
}

/// A malformed frame: the connection closes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireError(pub String);

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WireError {}

/// One frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    /// Its type.
    pub kind: Kind,
    /// Its payload.
    pub payload: Vec<u8>,
}

/// Encodes one frame.
///
/// # Panics
/// If the payload is larger than [`MAX_FRAME_BODY`] allows (a bug in the caller).
#[must_use]
pub fn encode(kind: Kind, payload: &[u8]) -> Vec<u8> {
    assert!(payload.len() < MAX_FRAME_BODY, "frame payload too large");
    let mut out = Vec::with_capacity(FRAME_HEADER + payload.len());
    let body = u32::try_from(payload.len() + 1).unwrap_or(u32::MAX);
    out.extend_from_slice(&body.to_le_bytes());
    out.push(kind as u8);
    out.extend_from_slice(payload);
    out
}

fn check_body(body: usize, kind_byte: u8) -> Result<Kind, WireError> {
    if body == 0 || body > MAX_FRAME_BODY {
        return Err(WireError(format!("invalid frame length {body}")));
    }
    Kind::from_byte(kind_byte)
        .ok_or_else(|| WireError(format!("unknown frame type {kind_byte:#04x}")))
}

/// Parses exactly one frame (a relay WebSocket message).
///
/// # Errors
/// A length that doesn't match, an unknown type, or a frame over the limit.
pub fn parse(bytes: &[u8]) -> Result<Frame, WireError> {
    if bytes.len() < FRAME_HEADER {
        return Err(WireError("short frame".into()));
    }
    let body = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let kind = check_body(body, bytes[4])?;
    if bytes.len() != 4 + body {
        return Err(WireError(format!(
            "frame length {body} but {} bytes",
            bytes.len() - 4
        )));
    }
    Ok(Frame {
        kind,
        payload: bytes[FRAME_HEADER..].to_vec(),
    })
}

/// Splits a byte stream (a WebTransport stream) into frames.
#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}

impl Decoder {
    /// Adds bytes and returns the frames they complete.
    ///
    /// # Errors
    /// On the first malformed frame; the stream must close.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, WireError> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut start = 0;
        while self.buffer.len() - start >= FRAME_HEADER {
            let b = &self.buffer[start..];
            let body = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
            let kind = check_body(body, b[4])?;
            if b.len() < 4 + body {
                break;
            }
            frames.push(Frame {
                kind,
                payload: b[FRAME_HEADER..4 + body].to_vec(),
            });
            start += 4 + body;
        }
        self.buffer.drain(..start);
        Ok(frames)
    }

    /// Bytes waiting for the rest of their frame.
    #[must_use]
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }
}

/// An init frame's header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitHeader {
    /// The protocol version the phone speaks.
    pub version: u8,
    /// How it connects.
    pub mode: Mode,
    /// The pairing id (pair), the phone's mailbox id (reconnect) or the code's mailbox (code).
    pub id: [u8; 16],
}

impl InitHeader {
    /// The header's 18 bytes.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; INIT_HEADER] {
        let mut out = [0u8; INIT_HEADER];
        out[0] = self.version;
        out[1] = self.mode as u8;
        out[2..].copy_from_slice(&self.id);
        out
    }

    /// Splits an init payload into its header and the handshake message.
    ///
    /// # Errors
    /// [`Refusal::Incompatible`] for another protocol version, [`Refusal::Protocol`]
    /// for a short payload or an unknown mode.
    pub fn parse(payload: &[u8]) -> Result<(Self, &[u8]), Refusal> {
        if payload.is_empty() {
            return Err(Refusal::Protocol);
        }
        if payload[0] != PROTOCOL_VERSION {
            return Err(Refusal::Incompatible);
        }
        if payload.len() < INIT_HEADER {
            return Err(Refusal::Protocol);
        }
        let mode = Mode::from_byte(payload[1]).ok_or(Refusal::Protocol)?;
        let mut id = [0u8; 16];
        id.copy_from_slice(&payload[2..INIT_HEADER]);
        Ok((
            Self {
                version: payload[0],
                mode,
                id,
            },
            &payload[INIT_HEADER..],
        ))
    }
}

/// A [`Kind::Refused`] payload.
#[must_use]
pub fn refusal_payload(refusal: Refusal, text: &str) -> Vec<u8> {
    let mut out = vec![refusal as u8];
    let mut end = text.len().min(MAX_REFUSAL_TEXT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    out.extend_from_slice(&text.as_bytes()[..end]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn frames_round_trip_through_the_decoder_in_any_split() {
        let mut stream = encode(Kind::Init, &[1, 2, 3]);
        stream.extend(encode(Kind::Sealed, &vec![7; 60_000]));
        stream.extend(encode(
            Kind::Refused,
            &refusal_payload(Refusal::Busy, "busy"),
        ));
        for split in [1, 2, 5, 4096, stream.len()] {
            let mut decoder = Decoder::default();
            let mut frames = Vec::new();
            for chunk in stream.chunks(split) {
                frames.extend(decoder.push(chunk).expect("valid"));
            }
            assert_eq!(frames.len(), 3);
            assert_eq!(
                frames[0],
                Frame {
                    kind: Kind::Init,
                    payload: vec![1, 2, 3]
                }
            );
            assert_eq!(frames[1].payload.len(), 60_000);
            assert_eq!(frames[2].kind, Kind::Refused);
            assert_eq!(decoder.buffered(), 0);
        }
    }

    #[test]
    fn bad_frames_are_refused() {
        assert!(parse(&[0, 0, 0, 0, 0x20]).is_err(), "zero length");
        assert!(
            parse(&[2, 0, 0, 0, 0x01, 9]).is_err(),
            "an engine frame type"
        );
        assert!(parse(&[3, 0, 0, 0, 0x22, 9]).is_err(), "length mismatch");
        let huge = u32::try_from(MAX_FRAME_BODY + 1)
            .expect("fits")
            .to_le_bytes();
        assert!(
            Decoder::default()
                .push(&[huge[0], huge[1], huge[2], huge[3], 0x22])
                .is_err()
        );
        assert_eq!(
            parse(&encode(Kind::Reply, &[5])).expect("valid").payload,
            vec![5]
        );
    }

    #[test]
    fn init_headers_check_version_and_mode() {
        let header = InitHeader {
            version: PROTOCOL_VERSION,
            mode: Mode::Pair,
            id: [9; 16],
        };
        let mut payload = header.to_bytes().to_vec();
        payload.extend([1, 2]);
        let (parsed, rest) = InitHeader::parse(&payload).expect("valid");
        assert_eq!(parsed, header);
        assert_eq!(rest, &[1, 2]);
        payload[0] = 2;
        assert_eq!(InitHeader::parse(&payload), Err(Refusal::Incompatible));
        payload[0] = 1;
        payload[1] = 9;
        assert_eq!(InitHeader::parse(&payload), Err(Refusal::Protocol));
        assert_eq!(InitHeader::parse(&[1, 1]), Err(Refusal::Protocol));
    }

    #[test]
    fn refusal_text_is_cut_on_a_character_boundary() {
        let text = "é".repeat(150);
        let payload = refusal_payload(Refusal::Closed, &text);
        assert!(payload.len() <= 1 + MAX_REFUSAL_TEXT);
        assert!(std::str::from_utf8(&payload[1..]).is_ok());
    }

    proptest! {
        // Fuzz test of the parser (ROADMAP PC-2): any bytes, split anywhere,
        // give frames or an error, never a panic, and never a frame over the limit.
        #![proptest_config(ProptestConfig::with_cases(2_000))]
        #[test]
        fn decoder_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..400), split in 1usize..64) {
            let mut decoder = Decoder::default();
            for chunk in bytes.chunks(split) {
                match decoder.push(chunk) {
                    Ok(frames) => for frame in frames { prop_assert!(frame.payload.len() < MAX_FRAME_BODY); },
                    Err(_) => break,
                }
            }
            let _ = parse(&bytes);
            let _ = InitHeader::parse(&bytes);
        }

        #[test]
        fn encoded_frames_parse_back(kind in 0x20u8..=0x23, payload in proptest::collection::vec(any::<u8>(), 0..300)) {
            let kind = Kind::from_byte(kind).expect("valid kind");
            let frame = parse(&encode(kind, &payload)).expect("valid");
            prop_assert_eq!(frame.kind, kind);
            prop_assert_eq!(frame.payload, payload);
        }
    }
}
