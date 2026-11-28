//! The pairing QR code (PLAN §4.16, "Pairing in detail"): a link to the phone
//! app whose fragment holds about 150 bytes, which browsers never send to the
//! app's host: format version, pairing id, one-time secret, the laptop's public
//! key, its certificate's hash, an expiry, the tab to open, up to three LAN
//! addresses and, if one is set up, the relay. No project or person is named:
//! a QR code on a projector can be photographed.
//!
//! Layout (all integers big-endian):
//! `u8 version · u8 flags · [16] id · [32] secret · [32] laptop key · [32]
//! certificate hash · u32 expiry (Unix s) · u8 view · u8 n · n × (u8 family 4|6,
//! [4|16] address, u16 port) · if flags & 1: u8 length, relay URL (UTF-8)`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore as _;

/// The payload format this build writes and reads.
pub const QR_VERSION: u8 = 1;
/// Most LAN addresses a QR code carries.
pub const MAX_ADDRESSES: usize = 3;
/// Longest relay URL, bytes.
pub const MAX_RELAY: usize = 120;
const FLAG_RELAY: u8 = 1;

/// The views a phone opens first (`triage.ts`'s Engineering tabs that a phone shows).
pub const VIEWS: [&str; 4] = ["board", "schematic", "3d", "sim"];

/// What a pairing QR code holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payload {
    /// The pairing id: 16 random bytes, also the relay mailbox while pairing.
    pub id: [u8; 16],
    /// The one-time secret: the handshake's pre-shared key.
    pub secret: [u8; 32],
    /// The laptop's static X25519 public key.
    pub laptop_key: [u8; 32],
    /// SHA-256 of the laptop's current certificate (DER), for `serverCertificateHashes`.
    pub certificate_hash: [u8; 32],
    /// When the code stops working, Unix seconds.
    pub expires: u32,
    /// Index into [`VIEWS`].
    pub view: u8,
    /// Where the laptop listens on the LAN.
    pub addresses: Vec<SocketAddr>,
    /// The relay's URL (`wss://…`), if one is set up.
    pub relay: Option<String>,
}

/// A payload that doesn't parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayloadError(pub &'static str);

impl std::fmt::Display for PayloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for PayloadError {}

impl Payload {
    /// The payload's bytes.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(160);
        out.push(QR_VERSION);
        out.push(if self.relay.is_some() { FLAG_RELAY } else { 0 });
        out.extend_from_slice(&self.id);
        out.extend_from_slice(&self.secret);
        out.extend_from_slice(&self.laptop_key);
        out.extend_from_slice(&self.certificate_hash);
        out.extend_from_slice(&self.expires.to_be_bytes());
        out.push(self.view);
        let addresses = &self.addresses[..self.addresses.len().min(MAX_ADDRESSES)];
        out.push(u8::try_from(addresses.len()).unwrap_or(0));
        for address in addresses {
            match address.ip() {
                IpAddr::V4(ip) => {
                    out.push(4);
                    out.extend_from_slice(&ip.octets());
                }
                IpAddr::V6(ip) => {
                    out.push(6);
                    out.extend_from_slice(&ip.octets());
                }
            }
            out.extend_from_slice(&address.port().to_be_bytes());
        }
        if let Some(relay) = &self.relay {
            let bytes = &relay.as_bytes()[..relay.len().min(MAX_RELAY)];
            out.push(u8::try_from(bytes.len()).unwrap_or(0));
            out.extend_from_slice(bytes);
        }
        out
    }

    /// Reads a payload's bytes.
    ///
    /// # Errors
    /// Another format version, a short or overlong payload, an unknown address family.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, PayloadError> {
        let mut reader = Reader { bytes, at: 0 };
        if reader.u8()? != QR_VERSION {
            return Err(PayloadError("another QR format version"));
        }
        let flags = reader.u8()?;
        let id = reader.array::<16>()?;
        let secret = reader.array::<32>()?;
        let laptop_key = reader.array::<32>()?;
        let certificate_hash = reader.array::<32>()?;
        let expires = u32::from_be_bytes(reader.array::<4>()?);
        let view = reader.u8()?;
        if usize::from(view) >= VIEWS.len() {
            return Err(PayloadError("unknown view"));
        }
        let count = usize::from(reader.u8()?);
        if count > MAX_ADDRESSES {
            return Err(PayloadError("too many addresses"));
        }
        let mut addresses = Vec::with_capacity(count);
        for _ in 0..count {
            let ip = match reader.u8()? {
                4 => IpAddr::V4(Ipv4Addr::from(reader.array::<4>()?)),
                6 => IpAddr::V6(Ipv6Addr::from(reader.array::<16>()?)),
                _ => return Err(PayloadError("unknown address family")),
            };
            let port = u16::from_be_bytes(reader.array::<2>()?);
            addresses.push(SocketAddr::new(ip, port));
        }
        let relay = if flags & FLAG_RELAY == 0 {
            None
        } else {
            let length = usize::from(reader.u8()?);
            let text = reader.take(length)?;
            Some(
                String::from_utf8(text.to_vec())
                    .map_err(|_| PayloadError("relay URL is not UTF-8"))?,
            )
        };
        if reader.at != bytes.len() {
            return Err(PayloadError("trailing bytes"));
        }
        Ok(Self {
            id,
            secret,
            laptop_key,
            certificate_hash,
            expires,
            view,
            addresses,
            relay,
        })
    }

    /// The link the QR code shows: `<app URL>/p#<payload, base64url>`.
    #[must_use]
    pub fn link(&self, app_url: &str) -> String {
        format!(
            "{}/p#{}",
            app_url.trim_end_matches('/'),
            URL_SAFE_NO_PAD.encode(self.to_bytes())
        )
    }

    /// Reads the payload of a [`Payload::link`] (or the bare fragment).
    ///
    /// # Errors
    /// No fragment, bad base64url, or a payload that doesn't parse.
    pub fn from_link(link: &str) -> Result<Self, PayloadError> {
        let fragment = link.rsplit_once('#').map_or(link, |(_, fragment)| fragment);
        let bytes = URL_SAFE_NO_PAD
            .decode(fragment.trim_start_matches("p="))
            .map_err(|_| PayloadError("not base64url"))?;
        Self::from_bytes(&bytes)
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], PayloadError> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(PayloadError("short payload"))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, PayloadError> {
        Ok(self.take(1)?[0])
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], PayloadError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }
}

/// Fresh random bytes (the pairing id, secrets, mailbox ids).
#[must_use]
pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    rand::rng().fill_bytes(&mut out);
    out
}

/// Crockford's Base32 alphabet: no I, L, O or U, so a typed code has fewer mix-ups.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A fresh 8-character typed code (40 random bits), shown as `ABCD-EFGH` under the QR code.
#[must_use]
pub fn new_code() -> String {
    let bytes = random::<5>();
    let mut value = bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
    let mut out = [0u8; 8];
    for slot in out.iter_mut().rev() {
        *slot = CODE_ALPHABET[usize::try_from(value & 31).unwrap_or(0)];
        value >>= 5;
    }
    String::from_utf8(out.to_vec()).unwrap_or_default()
}

/// A typed code as the handshake uses it: upper case, without separators, with
/// the letters people mistake for digits mapped as Crockford's Base32 does.
/// `None` unless it is 8 characters of the alphabet.
#[must_use]
pub fn normalize_code(code: &str) -> Option<String> {
    let mut out = String::with_capacity(8);
    for c in code.chars() {
        let c = match c.to_ascii_uppercase() {
            '-' | ' ' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        if !c.is_ascii() || !CODE_ALPHABET.contains(&(c as u8)) {
            return None;
        }
        out.push(c);
    }
    (out.len() == 8).then_some(out)
}

/// The QR code's modules for `text` (error correction M): its width and one bool
/// per module, row by row, `true` for dark.
///
/// # Errors
/// If the text is too long for any QR code version.
pub fn modules(text: &str) -> Result<(usize, Vec<bool>), PayloadError> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M)
        .map_err(|_| PayloadError("too long for a QR code"))?;
    let width = code.width();
    let dark = code
        .to_colors()
        .into_iter()
        .map(|c| c == qrcode::Color::Dark)
        .collect();
    Ok((width, dark))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn sample() -> Payload {
        Payload {
            id: [1; 16],
            secret: [2; 32],
            laptop_key: [3; 32],
            certificate_hash: [4; 32],
            expires: 1_800_000_000,
            view: 0,
            addresses: vec![
                "192.168.1.20:47120".parse().expect("address"),
                "[fd00::5]:47120".parse().expect("address"),
            ],
            relay: Some("wss://relay.example/".into()),
        }
    }

    #[test]
    fn payloads_round_trip_and_stay_small() {
        let payload = sample();
        let bytes = payload.to_bytes();
        assert!(bytes.len() <= 190, "{} bytes", bytes.len());
        assert_eq!(Payload::from_bytes(&bytes).expect("valid"), payload);
        let link = payload.link("https://example.github.io/triage/");
        assert!(link.starts_with("https://example.github.io/triage/p#"));
        assert_eq!(Payload::from_link(&link).expect("valid"), payload);
        let (width, dark) = modules(&link).expect("fits");
        assert_eq!(dark.len(), width * width);
        assert!(
            width <= 77,
            "QR version {} is hard to scan",
            (width - 17) / 4
        );
    }

    #[test]
    fn bad_payloads_are_refused() {
        let mut bytes = sample().to_bytes();
        bytes[0] = 2;
        assert!(Payload::from_bytes(&bytes).is_err());
        let bytes = sample().to_bytes();
        assert!(Payload::from_bytes(&bytes[..bytes.len() - 1]).is_err());
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(Payload::from_bytes(&longer).is_err());
    }

    #[test]
    fn codes_are_eight_characters_of_crockford_base32() {
        for _ in 0..100 {
            let code = new_code();
            assert_eq!(normalize_code(&code), Some(code.clone()));
        }
        assert_eq!(normalize_code("abcd-efgh").as_deref(), Some("ABCDEFGH"));
        assert_eq!(normalize_code("o1il 2345").as_deref(), Some("01112345"));
        assert_eq!(normalize_code("ABCDEFG"), None);
        assert_eq!(normalize_code("ABCDEFGU"), None);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2_000))]
        #[test]
        fn payload_parser_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..260)) {
            let _ = Payload::from_bytes(&bytes);
            let _ = Payload::from_link(&String::from_utf8_lossy(&bytes));
        }
    }
}
