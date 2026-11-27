//! Virtual time: one clock in `i64` picoseconds (PLAN §4.7), about 106 days of
//! range, exact for every MCU clock Triage emulates (a 16 MHz AVR cycle is
//! 62 500 ps).

use std::fmt;
use std::ops::{Add, AddAssign, Sub};

use serde::{Deserialize, Serialize};

/// A point on the virtual clock, in picoseconds since the start of the run.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct SimTime(pub i64);

/// A span of virtual time, in picoseconds.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct SimDuration(pub i64);

/// Picoseconds per nanosecond, microsecond, millisecond and second.
pub const PS_PER_NS: i64 = 1_000;
/// Picoseconds per microsecond.
pub const PS_PER_US: i64 = 1_000_000;
/// Picoseconds per millisecond.
pub const PS_PER_MS: i64 = 1_000_000_000;
/// Picoseconds per second.
pub const PS_PER_S: i64 = 1_000_000_000_000;

impl SimTime {
    /// The start of every run.
    pub const ZERO: SimTime = SimTime(0);
    /// Later than any time a run reaches.
    pub const MAX: SimTime = SimTime(i64::MAX);

    /// This time in seconds (for solvers and display).
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn seconds(self) -> f64 {
        self.0 as f64 / PS_PER_S as f64
    }

    /// A time from seconds, rounded to the nearest picosecond.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn from_seconds(seconds: f64) -> SimTime {
        SimTime((seconds * 1e12).round() as i64)
    }

    /// The span from `earlier` to this time.
    #[must_use]
    pub fn since(self, earlier: SimTime) -> SimDuration {
        SimDuration(self.0 - earlier.0)
    }
}

impl SimDuration {
    /// No time.
    pub const ZERO: SimDuration = SimDuration(0);

    /// A span of `n` microseconds.
    #[must_use]
    pub const fn from_micros(n: i64) -> SimDuration {
        SimDuration(n * PS_PER_US)
    }

    /// A span of `n` milliseconds.
    #[must_use]
    pub const fn from_millis(n: i64) -> SimDuration {
        SimDuration(n * PS_PER_MS)
    }

    /// A span from seconds, rounded to the nearest picosecond.
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn from_seconds(seconds: f64) -> SimDuration {
        SimDuration((seconds * 1e12).round() as i64)
    }

    /// This span in seconds.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn seconds(self) -> f64 {
        self.0 as f64 / PS_PER_S as f64
    }
}

impl Add<SimDuration> for SimTime {
    type Output = SimTime;
    fn add(self, rhs: SimDuration) -> SimTime {
        SimTime(self.0.saturating_add(rhs.0))
    }
}

impl AddAssign<SimDuration> for SimTime {
    fn add_assign(&mut self, rhs: SimDuration) {
        *self = *self + rhs;
    }
}

impl Sub for SimTime {
    type Output = SimDuration;
    fn sub(self, rhs: SimTime) -> SimDuration {
        SimDuration(self.0 - rhs.0)
    }
}

impl fmt::Display for SimTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:.6} s", self.seconds())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_avr_cycle_is_exact() {
        // 16 MHz: 62.5 ns per cycle.
        assert_eq!(PS_PER_S / 16_000_000, 62_500);
        assert_eq!(SimTime::from_seconds(1.5), SimTime(1_500_000_000_000));
        assert!((SimTime(PS_PER_MS).seconds() - 0.001).abs() < 1e-15);
        assert_eq!(SimTime(10) + SimDuration(5), SimTime(15));
        assert_eq!(SimTime(10) - SimTime(4), SimDuration(6));
        assert_eq!(SimTime::MAX + SimDuration(1), SimTime::MAX);
    }
}
