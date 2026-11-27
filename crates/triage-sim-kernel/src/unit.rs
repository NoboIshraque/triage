//! Units: each engine in a co-simulation (an MCU emulator, the circuit solver,
//! the physics engine, a part, the environment, a stub) is wrapped with the same
//! FMI-3-like contract (PLAN §4.7): advance from now to a time, reading inputs
//! from the bus and writing outputs to it.

use serde::{Deserialize, Serialize};

use crate::signal::{SignalBus, SignalId, Value};
use crate::time::SimTime;

/// What part of the device a unit simulates; scopes pick units by domain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Domain {
    /// Firmware on an emulated board.
    Firmware,
    /// The circuit solver.
    Circuit,
    /// Physics of the mechanism.
    Mechanics,
    /// Room temperature, light, distances, the supply.
    Environment,
    /// Behavioral part models (displays, sensors) outside the circuit solver.
    Parts,
    /// A stand-in inserted by a scope.
    Stub,
}

impl Domain {
    /// Every domain a scope can run.
    pub const RUNNABLE: [Domain; 5] = [
        Domain::Firmware,
        Domain::Circuit,
        Domain::Mechanics,
        Domain::Environment,
        Domain::Parts,
    ];

    /// The name used in scope files.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::Firmware => "firmware",
            Domain::Circuit => "circuit",
            Domain::Mechanics => "mechanics",
            Domain::Environment => "environment",
            Domain::Parts => "parts",
            Domain::Stub => "stub",
        }
    }

    /// The domain named in a scope file.
    #[must_use]
    pub fn parse(name: &str) -> Option<Domain> {
        Domain::RUNNABLE
            .into_iter()
            .chain([Domain::Stub])
            .find(|d| d.as_str() == name)
    }
}

/// How the scheduler treats a unit (PLAN §4.7, Renode's time phases).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UnitKind {
    /// Produces timestamped events (an MCU, a signal generator). Runs first in each
    /// quantum, up to the quantum's end or its first output event.
    Producer,
    /// Advances continuously with held inputs (circuit, physics, environment).
    /// Catches up to each event and the end of the quantum in the sync phase.
    Continuous,
}

/// A timestamped output of a producer, applied to the bus in the sync phase.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// When the output changes.
    pub t: SimTime,
    /// Which signal.
    pub signal: SignalId,
    /// Its new value.
    pub value: Value,
}

/// What a unit sees during one step.
pub struct StepContext<'a> {
    /// The bus: read any signal; continuous units write their outputs here.
    pub bus: &'a mut SignalBus,
    /// Where the step starts.
    pub now: SimTime,
    /// Where it should end (the unit may stop earlier and say so).
    pub until: SimTime,
    pub(crate) events: &'a mut Vec<Event>,
}

impl<'a> StepContext<'a> {
    /// A context for stepping a unit outside a kernel (a host running a unit
    /// against its own copy of the bus); `events` collects what it emits.
    pub fn host(
        bus: &'a mut SignalBus,
        now: SimTime,
        until: SimTime,
        events: &'a mut Vec<Event>,
    ) -> StepContext<'a> {
        StepContext {
            bus,
            now,
            until,
            events,
        }
    }

    /// A producer's output at time `t` (between `now` and the time it reaches).
    pub fn emit(&mut self, t: SimTime, signal: SignalId, value: Value) {
        self.events.push(Event { t, signal, value });
    }

    /// A continuous unit's output at the end of its step.
    pub fn set(&mut self, signal: SignalId, value: Value) {
        self.bus.set(signal, self.until, value);
    }

    /// An output that holds from the start of the step (a stub's or a control's
    /// piecewise-constant value).
    pub fn set_from_start(&mut self, signal: SignalId, value: Value) {
        self.bus.set(signal, self.now, value);
    }

    /// A signal's current value as a number.
    #[must_use]
    pub fn real(&self, signal: SignalId) -> f64 {
        self.bus.real(signal)
    }
}

/// One engine wrapped for the kernel.
pub trait Unit {
    /// Unique name, for example `circuit` or `stub:A1.D9.drive`.
    fn name(&self) -> &str;
    /// The part of the device it simulates.
    fn domain(&self) -> Domain;
    /// How the scheduler steps it.
    fn kind(&self) -> UnitKind;
    /// Signals it reads.
    fn reads(&self) -> Vec<SignalId>;
    /// Signals it writes (each signal has one writer).
    fn writes(&self) -> Vec<SignalId>;
    /// Advances from `ctx.now` to `ctx.until` and returns the time it reached:
    /// `ctx.until`, or earlier for a producer that stops at its first output event.
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime;
    /// Names of the controls it accepts (`SW1.pressed`, `room_temperature_c`).
    fn controls(&self) -> Vec<String> {
        Vec::new()
    }
    /// Sets a control (a UI slider, a scenario stimulus). Returns whether it knew it.
    fn control(&mut self, _name: &str, _value: f64) -> bool {
        false
    }
    /// The unit's state, for checkpoints (FMI's get/set FMU state).
    fn save(&self) -> Vec<u8> {
        Vec::new()
    }
    /// Restores a state from [`Unit::save`].
    fn restore(&mut self, _state: &[u8]) -> bool {
        false
    }
    /// Readouts for instruments and the UI (`rpm`, `brightness`).
    fn readouts(&self) -> Vec<(String, f64)> {
        Vec::new()
    }
}
