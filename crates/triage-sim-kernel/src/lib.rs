//! Triage's co-simulation kernel (ROADMAP P3-1, PLAN §4.7).
//!
//! - [`time`]: one virtual clock in `i64` picoseconds.
//! - [`signal`]: the signal bus, with traces of every change.
//! - [`unit`]: the contract every engine is wrapped in (MCU, circuit, physics …).
//! - [`kernel`]: the conservative quantum scheduler with grant, sync and unblock
//!   phases, hosts for producers outside Rust (the AVR emulator), inputs from the
//!   UI and scenarios, and the recording that replays a run exactly.
//! - [`scope`] and [`stub`]: running the whole device or any part of it, with
//!   control, hold, trace, ideal and open stubs at the boundary.
//!
//! The kernel is single-threaded and deterministic: the same units, the same
//! inputs at the same virtual times and the same seeds give the same traces
//! ([`signal::SignalBus::trace_hash`]).

pub mod kernel;
pub mod scope;
pub mod signal;
pub mod stub;
pub mod time;
pub mod unit;

pub use kernel::{
    Grant, HostId, HostInputs, HostReport, Input, Kernel, KernelConfig, KernelError, KernelStats,
    Unblock,
};
pub use scope::{Cut, HostSpec, Scope, StubInfo, cut};
pub use signal::{Change, Logic, SignalBus, SignalId, SignalKind, Value};
pub use stub::{Generator, IdealModel, StubSpec, make_stub};
pub use time::{PS_PER_MS, PS_PER_NS, PS_PER_S, PS_PER_US, SimDuration, SimTime};
pub use unit::{Domain, Event, StepContext, Unit, UnitKind};

/// A small deterministic random number generator (`SplitMix64`) for seeded noise:
/// the same seed gives the same numbers on every platform.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// A generator from a seed.
    #[must_use]
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }

    /// The next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A uniform number in [0, 1).
    #[allow(clippy::cast_precision_loss)]
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// A normally distributed number (Box–Muller), mean 0, deviation 1.
    pub fn gaussian(&mut self) -> f64 {
        let u1 = self.next_f64().max(1e-300);
        let u2 = self.next_f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
}
