//! The phone and tablet companion's laptop side (ROADMAP PC, ADR 0005, PLAN
//! §4.16): a phone app paired by a QR code shows Triage's tabs while the laptop
//! does the work. This crate holds what must be exact and fast:
//!
//! - [`qr`]: the pairing QR code's payload, the typed code, the QR's modules;
//! - [`wire`]: the frames on a WebTransport stream or a relay WebSocket;
//! - [`noise`]: the end-to-end Noise sessions (`IKpsk2` to pair, `IK` to
//!   reconnect, `NNpsk0` for a typed code) and the six digits both screens show;
//! - [`cert`]: the self-signed certificates phones pin, renewed every 13 days;
//! - [`pairing`]: open pairings and paired phones;
//! - [`server`]: the WebTransport server and the relay client.
//!
//! The companion broker (`companionBrokerMain.ts`) loads it as a Node addon
//! (`crates/triage-companion-node`); the phone app speaks the same protocol in
//! TypeScript with `WebCrypto` (`app/src/vs/triage/common/companion/`).

pub mod cert;
pub mod noise;
pub mod pairing;
pub mod qr;
pub mod server;
pub mod wire;

pub use server::{Companion, Event, Route};
