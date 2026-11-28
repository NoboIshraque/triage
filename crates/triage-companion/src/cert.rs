//! The laptop's TLS certificates for WebTransport (PLAN §4.16, "Transport"):
//! self-signed ECDSA P-256 certificates that phones pin by their SHA-256 hash
//! (`serverCertificateHashes`). Browsers accept such a certificate only if it
//! is valid for two weeks or less, so the laptop renews it every 13 days and
//! hands connected phones the hash of the next one in advance: a phone in
//! regular use never needs a new QR code.
//!
//! A certificate starts to be served an hour after its `not_before` (for clocks
//! that run a little behind) and is valid for 14 days less a minute, so the one
//! being replaced still has about 23 hours left when the next takes over.

use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;

/// How often a new certificate takes over, s.
pub const RENEW_EVERY: i64 = 13 * 24 * 3600;
/// A certificate's validity, s (browsers allow 14 days at most).
pub const VALIDITY: i64 = 14 * 24 * 3600 - 60;
/// A certificate is served from `not_before` + this, s.
pub const LEAD: i64 = 3600;

/// One certificate and its private key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Certificate {
    /// The certificate, DER.
    pub der: Vec<u8>,
    /// Its private key, PKCS#8 DER.
    pub key_der: Vec<u8>,
    /// Start of validity, Unix s.
    pub not_before: i64,
    /// End of validity, Unix s.
    pub not_after: i64,
}

impl Certificate {
    /// SHA-256 of the DER, what `serverCertificateHashes` pins.
    #[must_use]
    pub fn hash(&self) -> [u8; 32] {
        hash(&self.der)
    }

    /// When this certificate is first served, Unix s.
    #[must_use]
    pub fn serves_from(&self) -> i64 {
        self.not_before + LEAD
    }
}

/// SHA-256 of a DER certificate.
#[must_use]
pub fn hash(der: &[u8]) -> [u8; 32] {
    Sha256::digest(der).into()
}

/// A certificate generation failure.
#[derive(Debug)]
pub struct CertError(pub String);

impl std::fmt::Display for CertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CertError {}

fn time_at(unix: i64) -> Result<OffsetDateTime, CertError> {
    OffsetDateTime::from_unix_timestamp(unix).map_err(|e| CertError(e.to_string()))
}

/// A new certificate valid from `not_before` (Unix s) for [`VALIDITY`].
///
/// # Errors
/// If the key or the certificate can't be made.
pub fn generate(not_before: i64) -> Result<Certificate, CertError> {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| CertError(e.to_string()))?;
    let mut params = rcgen::CertificateParams::new(vec!["triage-companion.local".to_string()])
        .map_err(|e| CertError(e.to_string()))?;
    let mut name = rcgen::DistinguishedName::new();
    name.push(rcgen::DnType::CommonName, "Triage companion");
    params.distinguished_name = name;
    let not_after = not_before + VALIDITY;
    params.not_before = time_at(not_before)?;
    params.not_after = time_at(not_after)?;
    let certificate = params
        .self_signed(&key)
        .map_err(|e| CertError(e.to_string()))?;
    Ok(Certificate {
        der: certificate.der().to_vec(),
        key_der: key.serialize_der(),
        not_before,
        not_after,
    })
}

/// The certificates to keep at `now` (Unix s): the one being served and the next
/// one, generating what's missing and dropping expired ones. Sorted by start.
///
/// # Errors
/// If a certificate can't be made.
pub fn plan(mut certificates: Vec<Certificate>, now: i64) -> Result<Vec<Certificate>, CertError> {
    certificates.retain(|c| c.not_after > now + 60 && c.not_after - c.not_before <= 14 * 24 * 3600);
    certificates.sort_by_key(|c| c.not_before);
    certificates.dedup_by_key(|c| c.not_before);
    let current = certificates
        .iter()
        .rposition(|c| c.serves_from() <= now && now < c.serves_from() + RENEW_EVERY);
    let current = if let Some(index) = current {
        certificates.drain(..index);
        certificates.truncate(2);
        certificates[0].clone()
    } else {
        // None serves now (first start, or the laptop slept past a renewal).
        let fresh = generate(now - LEAD)?;
        certificates.retain(|c| c.serves_from() > now);
        certificates.insert(0, fresh.clone());
        certificates.truncate(2);
        fresh
    };
    let next_start = current.not_before + RENEW_EVERY;
    if certificates
        .get(1)
        .is_none_or(|next| next.not_before != next_start)
    {
        certificates.truncate(1);
        certificates.push(generate(next_start)?);
    }
    Ok(certificates)
}

/// The certificate to serve at `now` from a [`plan`].
#[must_use]
pub fn current(certificates: &[Certificate], now: i64) -> Option<&Certificate> {
    certificates
        .iter()
        .rev()
        .find(|c| c.serves_from() <= now && now < c.not_after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_has_the_served_certificate_and_the_next_one() {
        let now = 1_800_000_000;
        let first = plan(Vec::new(), now).expect("plan");
        assert_eq!(first.len(), 2);
        assert_eq!(current(&first, now), Some(&first[0]));
        assert!(
            first
                .iter()
                .all(|c| c.not_after - c.not_before <= 14 * 24 * 3600)
        );
        assert_eq!(first[1].not_before - first[0].not_before, RENEW_EVERY);
        // Planning again changes nothing.
        assert_eq!(plan(first.clone(), now + 60).expect("plan"), first);
        // At renewal the next one is served and a new next one appears.
        let later = first[1].serves_from() + 10;
        let renewed = plan(first.clone(), later).expect("plan");
        assert_eq!(renewed[0], first[1]);
        assert_eq!(current(&renewed, later), Some(&first[1]));
        assert_eq!(renewed.len(), 2);
        // The served one overlaps its successor by almost a day.
        assert!(first[0].not_after > first[1].serves_from() + 22 * 3600);
        // After a long sleep, a fresh pair.
        let asleep = now + 40 * 24 * 3600;
        let fresh = plan(renewed, asleep).expect("plan");
        assert_eq!(current(&fresh, asleep), Some(&fresh[0]));
    }

    #[test]
    fn hashes_are_sha256_of_the_der() {
        let c = generate(1_800_000_000).expect("certificate");
        assert_eq!(c.hash(), hash(&c.der));
        assert_ne!(c.hash(), [0; 32]);
        assert!(c.key_der.len() > 32);
    }
}
