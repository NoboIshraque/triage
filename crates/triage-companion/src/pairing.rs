//! What the laptop admits (PLAN §4.16, "Pairing in detail"): open pairings (a
//! QR code's one-time secret, or a typed code's key) and paired phones.
//!
//! A pairing admits one phone: once the person at the laptop clicks **Allow** it
//! is used, and a reused QR code is refused. Five failed attempts (a wrong
//! secret, or **Deny**) end it. While one phone is answering a pairing, another
//! is told it's busy. Expiry is the laptop's: the QR code rotates every 45 s.

use std::collections::HashMap;

use crate::wire::{Mode, Refusal};

/// Failed attempts that end a pairing.
pub const MAX_ATTEMPTS: u8 = 5;

#[derive(Clone, Debug)]
struct Pairing {
    mode: Mode,
    psk: [u8; 32],
    expires_ms: i64,
    attempts: u8,
    used: bool,
    busy: bool,
}

/// Open pairings and paired phones.
#[derive(Default, Debug)]
pub struct Registry {
    pairings: HashMap<[u8; 16], Pairing>,
    phones: HashMap<[u8; 16], [u8; 32]>,
}

impl Registry {
    /// Opens a pairing: `id` is the QR code's pairing id or the typed code's mailbox.
    pub fn add_pairing(&mut self, id: [u8; 16], mode: Mode, psk: [u8; 32], expires_ms: i64) {
        self.pairings.insert(
            id,
            Pairing {
                mode,
                psk,
                expires_ms,
                attempts: 0,
                used: false,
                busy: false,
            },
        );
    }

    /// Closes a pairing (the QR code rotated, or the dialog closed).
    pub fn remove_pairing(&mut self, id: &[u8; 16]) {
        self.pairings.remove(id);
    }

    /// Starts a handshake on a pairing; returns its PSK.
    ///
    /// # Errors
    /// The refusal to send: unknown, expired or used ([`Refusal::Expired`]),
    /// [`Refusal::TooManyAttempts`], [`Refusal::Busy`].
    pub fn begin(&mut self, mode: Mode, id: &[u8; 16], now_ms: i64) -> Result<[u8; 32], Refusal> {
        let pairing = self.pairings.get_mut(id).ok_or(Refusal::Expired)?;
        if pairing.mode != mode || pairing.used || now_ms > pairing.expires_ms {
            return Err(Refusal::Expired);
        }
        if pairing.attempts >= MAX_ATTEMPTS {
            return Err(Refusal::TooManyAttempts);
        }
        if pairing.busy {
            return Err(Refusal::Busy);
        }
        pairing.busy = true;
        Ok(pairing.psk)
    }

    /// Ends a handshake started with [`Registry::begin`] (the session closed).
    pub fn end(&mut self, id: &[u8; 16]) {
        if let Some(pairing) = self.pairings.get_mut(id) {
            pairing.busy = false;
        }
    }

    /// Counts a failed attempt; returns the count (at [`MAX_ATTEMPTS`] the pairing is over).
    pub fn fail(&mut self, id: &[u8; 16]) -> u8 {
        self.pairings.get_mut(id).map_or(MAX_ATTEMPTS, |pairing| {
            pairing.attempts = pairing.attempts.saturating_add(1);
            pairing.attempts
        })
    }

    /// Marks a pairing used: its phone was allowed in, and it admits no other.
    pub fn consume(&mut self, id: &[u8; 16]) {
        if let Some(pairing) = self.pairings.get_mut(id) {
            pairing.used = true;
        }
    }

    /// Replaces the paired phones: mailbox id → static public key.
    pub fn set_phones(&mut self, phones: impl IntoIterator<Item = ([u8; 16], [u8; 32])>) {
        self.phones = phones.into_iter().collect();
    }

    /// The key of the phone paired under `mailbox`.
    #[must_use]
    pub fn phone(&self, mailbox: &[u8; 16]) -> Option<[u8; 32]> {
        self.phones.get(mailbox).copied()
    }

    /// Open pairings (tests).
    #[must_use]
    pub fn open_pairings(&self) -> usize {
        self.pairings.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pairing_admits_one_phone_and_counts_failures() {
        let mut registry = Registry::default();
        let id = [1; 16];
        registry.add_pairing(id, Mode::Pair, [2; 32], 1_000);
        assert_eq!(
            registry.begin(Mode::Reconnect, &id, 0),
            Err(Refusal::Expired),
            "another mode"
        );
        assert_eq!(registry.begin(Mode::Pair, &id, 0), Ok([2; 32]));
        assert_eq!(registry.begin(Mode::Pair, &id, 0), Err(Refusal::Busy));
        registry.end(&id);
        for attempt in 1..MAX_ATTEMPTS {
            assert_eq!(registry.fail(&id), attempt);
        }
        assert!(registry.begin(Mode::Pair, &id, 0).is_ok());
        registry.end(&id);
        assert_eq!(registry.fail(&id), MAX_ATTEMPTS);
        assert_eq!(
            registry.begin(Mode::Pair, &id, 0),
            Err(Refusal::TooManyAttempts)
        );
        let other = [3; 16];
        registry.add_pairing(other, Mode::Pair, [4; 32], 1_000);
        assert!(registry.begin(Mode::Pair, &other, 0).is_ok());
        registry.consume(&other);
        registry.end(&other);
        assert_eq!(
            registry.begin(Mode::Pair, &other, 0),
            Err(Refusal::Expired),
            "reused"
        );
        registry.add_pairing(other, Mode::Pair, [4; 32], 1_000);
        assert_eq!(
            registry.begin(Mode::Pair, &other, 1_001),
            Err(Refusal::Expired),
            "expired"
        );
        assert_eq!(
            registry.begin(Mode::Pair, &[9; 16], 0),
            Err(Refusal::Expired),
            "unknown"
        );
    }

    #[test]
    fn phones_are_looked_up_by_mailbox() {
        let mut registry = Registry::default();
        registry.set_phones([([1; 16], [5; 32])]);
        assert_eq!(registry.phone(&[1; 16]), Some([5; 32]));
        registry.set_phones([]);
        assert_eq!(registry.phone(&[1; 16]), None);
    }
}
