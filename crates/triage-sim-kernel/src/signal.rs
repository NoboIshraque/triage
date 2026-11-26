//! The signal bus: every value that crosses from one unit to another (a pin's
//! drive, a net's voltage, a motor's torque, the room temperature) is a named
//! signal with one writer. The bus keeps each signal's current value and, for
//! traced signals, every change with its virtual time.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::time::SimTime;

/// A digital level, with weak (pulled) levels and high impedance, like VHDL's
/// `std_logic` subset that pins need.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Logic {
    /// Driven low.
    Low,
    /// Driven high.
    High,
    /// Not driven (an input, or a disconnected wire).
    Z,
    /// Pulled low through a resistor.
    WeakLow,
    /// Pulled high through a resistor (an input with its pull-up on).
    WeakHigh,
}

impl Logic {
    /// The level a logic input reads (high impedance reads low).
    #[must_use]
    pub fn is_high(self) -> bool {
        matches!(self, Logic::High | Logic::WeakHigh)
    }

    /// Whether something drives this level hard.
    #[must_use]
    pub fn is_driven(self) -> bool {
        matches!(self, Logic::High | Logic::Low)
    }
}

/// A signal's value.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    /// A digital level.
    Logic(Logic),
    /// Any physical quantity in SI units (volts, amperes, rad/s, °C) or a 0–1 control.
    Real(f64),
}

impl Value {
    /// The value as a number: logic levels read as 0 or 1.
    #[must_use]
    pub fn as_real(self) -> f64 {
        match self {
            Value::Real(x) => x,
            Value::Logic(l) => {
                if l.is_high() {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }

    /// The value as a logic level: numbers above 0.5 read high.
    #[must_use]
    pub fn as_logic(self) -> Logic {
        match self {
            Value::Logic(l) => l,
            Value::Real(x) => {
                if x > 0.5 {
                    Logic::High
                } else {
                    Logic::Low
                }
            }
        }
    }

    /// Bits that identify this value exactly (for trace hashes).
    #[must_use]
    pub fn bits(self) -> u64 {
        match self {
            Value::Real(x) => x.to_bits(),
            Value::Logic(l) => 0xFFFF_0000_0000_0000 | l as u64,
        }
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Real(x) => write!(f, "{x}"),
            Value::Logic(l) => write!(f, "{l:?}"),
        }
    }
}

/// What a signal carries, so scopes can pick a fitting stub.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalKind {
    /// Digital levels (a pin's drive).
    Logic,
    /// A number.
    Real,
}

/// A signal's index on the bus.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SignalId(pub u32);

impl SignalId {
    fn index(self) -> usize {
        self.0 as usize
    }
}

/// One recorded change of a signal.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    /// When it changed.
    pub t: SimTime,
    /// The new value.
    pub value: Value,
}

#[derive(Clone, Debug)]
struct Slot {
    name: String,
    kind: SignalKind,
    value: Value,
    changed: SimTime,
    traced: bool,
    trace: Vec<Change>,
    /// Bumped on every change (units compare it to see what changed).
    version: u64,
}

/// The bus: named signals, their values and their traces.
#[derive(Clone, Debug, Default)]
pub struct SignalBus {
    slots: Vec<Slot>,
    by_name: HashMap<String, SignalId>,
}

impl SignalBus {
    /// An empty bus.
    #[must_use]
    pub fn new() -> SignalBus {
        SignalBus::default()
    }

    /// Declares a signal, or returns the existing one with that name.
    pub fn declare(&mut self, name: &str, kind: SignalKind, initial: Value) -> SignalId {
        if let Some(&id) = self.by_name.get(name) {
            return id;
        }
        let id = SignalId(u32::try_from(self.slots.len()).unwrap_or(u32::MAX));
        self.slots.push(Slot {
            name: name.to_owned(),
            kind,
            value: initial,
            changed: SimTime::ZERO,
            traced: false,
            trace: Vec::new(),
            version: 0,
        });
        self.by_name.insert(name.to_owned(), id);
        id
    }

    /// The signal with this name.
    #[must_use]
    pub fn id(&self, name: &str) -> Option<SignalId> {
        self.by_name.get(name).copied()
    }

    /// Number of signals.
    #[must_use]
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    /// Whether the bus has no signals.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// A signal's name.
    #[must_use]
    pub fn name(&self, id: SignalId) -> &str {
        &self.slots[id.index()].name
    }

    /// A signal's kind.
    #[must_use]
    pub fn kind(&self, id: SignalId) -> SignalKind {
        self.slots[id.index()].kind
    }

    /// A signal's current value.
    #[must_use]
    pub fn get(&self, id: SignalId) -> Value {
        self.slots[id.index()].value
    }

    /// A signal's current value as a number.
    #[must_use]
    pub fn real(&self, id: SignalId) -> f64 {
        self.get(id).as_real()
    }

    /// A signal's current value as a logic level.
    #[must_use]
    pub fn logic(&self, id: SignalId) -> Logic {
        self.get(id).as_logic()
    }

    /// When the signal last changed.
    #[must_use]
    pub fn changed_at(&self, id: SignalId) -> SimTime {
        self.slots[id.index()].changed
    }

    /// Counts the signal's changes (compare two readings to see whether it changed).
    #[must_use]
    pub fn version(&self, id: SignalId) -> u64 {
        self.slots[id.index()].version
    }

    /// Sets a signal at time `t`. Returns whether the value changed.
    pub fn set(&mut self, id: SignalId, t: SimTime, value: Value) -> bool {
        let slot = &mut self.slots[id.index()];
        if slot.value == value {
            return false;
        }
        slot.value = value;
        slot.changed = t;
        slot.version += 1;
        if slot.traced {
            slot.trace.push(Change { t, value });
        }
        true
    }

    /// Starts recording a signal's changes (its value now is the first entry).
    pub fn trace(&mut self, id: SignalId, now: SimTime) {
        let slot = &mut self.slots[id.index()];
        if !slot.traced {
            slot.traced = true;
            slot.trace.push(Change {
                t: now,
                value: slot.value,
            });
        }
    }

    /// Whether a signal is traced.
    #[must_use]
    pub fn is_traced(&self, id: SignalId) -> bool {
        self.slots[id.index()].traced
    }

    /// The recorded changes of a traced signal.
    #[must_use]
    pub fn changes(&self, id: SignalId) -> &[Change] {
        &self.slots[id.index()].trace
    }

    /// Forgets recorded changes before `t` (keeping the value in force at `t`).
    pub fn trim_traces(&mut self, t: SimTime) {
        for slot in &mut self.slots {
            if slot.trace.len() > 1 {
                let keep = slot.trace.partition_point(|c| c.t <= t).saturating_sub(1);
                slot.trace.drain(..keep);
            }
        }
    }

    /// All signal ids, in declaration order.
    pub fn ids(&self) -> impl Iterator<Item = SignalId> + '_ {
        (0..self.slots.len()).map(|i| SignalId(u32::try_from(i).unwrap_or(u32::MAX)))
    }

    /// A 64-bit FNV-1a hash of every trace (name, time and value of each change):
    /// two runs with the same hash recorded the same history.
    #[must_use]
    pub fn trace_hash(&self) -> u64 {
        let mut h = Fnv::new();
        for slot in self.slots.iter().filter(|s| s.traced) {
            h.write(slot.name.as_bytes());
            for change in &slot.trace {
                h.write(&change.t.0.to_le_bytes());
                h.write(&change.value.bits().to_le_bytes());
            }
        }
        h.finish()
    }
}

/// FNV-1a, 64 bits: small, stable across platforms and Rust versions.
pub(crate) struct Fnv(u64);

impl Fnv {
    pub(crate) fn new() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }

    pub(crate) fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    pub(crate) fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_records_changes_only() {
        let mut bus = SignalBus::new();
        let a = bus.declare("a", SignalKind::Real, Value::Real(0.0));
        assert_eq!(bus.declare("a", SignalKind::Real, Value::Real(9.0)), a);
        bus.trace(a, SimTime::ZERO);
        assert!(bus.set(a, SimTime(5), Value::Real(1.0)));
        assert!(!bus.set(a, SimTime(6), Value::Real(1.0)));
        assert!(bus.set(a, SimTime(7), Value::Real(2.0)));
        assert_eq!(bus.changes(a).len(), 3);
        assert_eq!(bus.version(a), 2);
        assert_eq!(bus.changed_at(a), SimTime(7));
        bus.trim_traces(SimTime(6));
        assert_eq!(
            bus.changes(a)[0],
            Change {
                t: SimTime(5),
                value: Value::Real(1.0)
            }
        );
    }

    #[test]
    fn logic_reads() {
        assert!(Value::Logic(Logic::WeakHigh).as_logic().is_high());
        assert!(!Value::Logic(Logic::Z).as_logic().is_high());
        assert!((Value::Logic(Logic::High).as_real() - 1.0).abs() < f64::EPSILON);
        assert_eq!(Value::Real(3.3).as_logic(), Logic::High);
    }
}
