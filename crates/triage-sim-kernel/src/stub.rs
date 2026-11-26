//! Stubs: what stands in for the parts of a device a scope leaves out
//! (PLAN §4.7). Each stub writes one signal:
//!
//! | Kind | Behaves as |
//! |---|---|
//! | **control** | a UI slider, switch or signal generator (PWM, sine): its value follows the controls set on it |
//! | **hold** | a fixed value |
//! | **trace** | replays a signal recorded in an earlier run, change by change at the recorded times |
//! | **ideal** | an ideal source (a driven level or voltage, whatever the load), or an ideal rotor (speed from torque, inertia and damping, no mechanism) |
//! | **open** | disconnected: high impedance for logic, zero for numbers |

use serde::{Deserialize, Serialize};

use crate::signal::{Change, Logic, SignalBus, SignalId, SignalKind, Value};
use crate::time::{SimDuration, SimTime};
use crate::unit::{Domain, StepContext, Unit, UnitKind};

/// A signal generator for control stubs.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "signal", rename_all = "lowercase")]
pub enum Generator {
    /// Logic PWM: high for `duty` of each period.
    Pwm {
        /// Fraction of each period that is high, 0–1.
        duty: f64,
        /// Frequency in hertz.
        freq_hz: f64,
    },
    /// A sine for number signals: `offset + amplitude · sin(2π f t)`.
    Sine {
        /// Middle value.
        offset: f64,
        /// Peak deviation.
        amplitude: f64,
        /// Frequency in hertz.
        freq_hz: f64,
    },
}

/// An ideal model for ideal stubs.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "model", rename_all = "kebab-case")]
pub enum IdealModel {
    /// A source that holds its value whatever the load (a driven level, a voltage).
    Source {
        /// The value it holds.
        value: Value,
    },
    /// A rotor without a mechanism: `J·dω/dt = τ − b·ω − c·ω·|ω|`, torque read
    /// from another signal (a motor part's torque), speed written to the stub's signal.
    Rotor {
        /// Moment of inertia, kg·m².
        inertia: f64,
        /// Viscous damping, N·m·s/rad.
        damping: f64,
        /// Quadratic (aerodynamic) drag, N·m·s²/rad².
        drag: f64,
    },
}

/// What a scope puts in place of a missing writer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StubSpec {
    /// Follows controls (`<signal>.value`, and `.duty` / `.freq_hz` for PWM).
    Control {
        /// Starting value.
        value: Value,
        /// Optional generator.
        #[serde(default)]
        generator: Option<Generator>,
    },
    /// A fixed value.
    Hold {
        /// The value.
        value: Value,
    },
    /// Replays recorded changes.
    Trace {
        /// Changes in time order.
        changes: Vec<Change>,
    },
    /// An ideal source or rotor.
    Ideal {
        /// Which model.
        #[serde(flatten)]
        model: IdealModel,
        /// For a rotor: the torque signal it reads.
        #[serde(default)]
        reads: Option<String>,
    },
    /// Disconnected.
    Open,
}

impl StubSpec {
    /// The kind's name.
    #[must_use]
    pub fn kind_name(&self) -> &'static str {
        match self {
            StubSpec::Control { .. } => "control",
            StubSpec::Hold { .. } => "hold",
            StubSpec::Trace { .. } => "trace",
            StubSpec::Ideal { .. } => "ideal",
            StubSpec::Open => "open",
        }
    }
}

/// Builds the unit for a stub on `signal`.
///
/// # Errors
/// When an ideal rotor's torque signal isn't on the bus.
pub fn make_stub(
    bus: &mut SignalBus,
    signal: SignalId,
    spec: &StubSpec,
) -> Result<Box<dyn Unit>, String> {
    let name = format!("stub:{}", bus.name(signal));
    Ok(match spec {
        StubSpec::Hold { value }
        | StubSpec::Ideal {
            model: IdealModel::Source { value },
            ..
        } => {
            bus.set(signal, SimTime::ZERO, *value);
            Box::new(Hold {
                name,
                signal,
                value: *value,
                kind: spec.kind_name(),
            })
        }
        StubSpec::Open => {
            let value = match bus.kind(signal) {
                SignalKind::Logic => Value::Logic(Logic::Z),
                SignalKind::Real => Value::Real(0.0),
            };
            bus.set(signal, SimTime::ZERO, value);
            Box::new(Hold {
                name,
                signal,
                value,
                kind: "open",
            })
        }
        StubSpec::Control { value, generator } => {
            bus.set(signal, SimTime::ZERO, *value);
            Box::new(Control {
                name,
                signal,
                value: *value,
                generator: *generator,
                period_start: SimTime::ZERO,
            })
        }
        StubSpec::Trace { changes } => Box::new(Trace {
            name,
            signal,
            changes: changes.clone(),
            next: 0,
        }),
        StubSpec::Ideal {
            model:
                IdealModel::Rotor {
                    inertia,
                    damping,
                    drag,
                },
            reads,
        } => {
            let torque_name = reads
                .as_deref()
                .ok_or("an ideal rotor needs the torque signal it reads")?;
            let torque = bus.id(torque_name).ok_or_else(|| {
                format!("an ideal rotor reads \"{torque_name}\", which isn't on the bus")
            })?;
            Box::new(Rotor {
                name,
                signal,
                torque,
                inertia: *inertia,
                damping: *damping,
                drag: *drag,
                omega: bus.real(signal),
            })
        }
    })
}

struct Hold {
    name: String,
    signal: SignalId,
    value: Value,
    kind: &'static str,
}

impl Unit for Hold {
    fn name(&self) -> &str {
        &self.name
    }
    fn domain(&self) -> Domain {
        Domain::Stub
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        Vec::new()
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.signal]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        ctx.set_from_start(self.signal, self.value);
        ctx.until
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        vec![(self.kind.to_owned(), self.value.as_real())]
    }
}

struct Control {
    name: String,
    signal: SignalId,
    value: Value,
    generator: Option<Generator>,
    period_start: SimTime,
}

impl Control {
    fn control_name(&self, what: &str) -> String {
        format!("{}.{what}", &self.name["stub:".len()..])
    }
}

impl Unit for Control {
    fn name(&self) -> &str {
        &self.name
    }
    fn domain(&self) -> Domain {
        Domain::Stub
    }
    fn kind(&self) -> UnitKind {
        // A PWM generator emits edges at exact times; everything else is held.
        if matches!(self.generator, Some(Generator::Pwm { .. })) {
            UnitKind::Producer
        } else {
            UnitKind::Continuous
        }
    }
    fn reads(&self) -> Vec<SignalId> {
        Vec::new()
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.signal]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        match self.generator {
            None => ctx.set_from_start(self.signal, self.value),
            Some(Generator::Sine {
                offset,
                amplitude,
                freq_hz,
            }) => {
                let x = offset
                    + amplitude * (std::f64::consts::TAU * freq_hz * ctx.until.seconds()).sin();
                ctx.set(self.signal, Value::Real(x));
            }
            Some(Generator::Pwm { duty, freq_hz }) => {
                let duty = duty.clamp(0.0, 1.0);
                if freq_hz <= 0.0 || duty <= 0.0 || duty >= 1.0 {
                    let level = if duty >= 1.0 { Logic::High } else { Logic::Low };
                    if ctx.bus.logic(self.signal) != level {
                        ctx.emit(ctx.now, self.signal, Value::Logic(level));
                    }
                    return ctx.until;
                }
                let period = SimDuration::from_seconds(1.0 / freq_hz);
                let high = SimDuration::from_seconds(duty / freq_hz);
                // Edges in [now, until): rising at each period start, falling after `high`.
                let mut start = self.period_start;
                while start + period <= ctx.now {
                    start += period;
                }
                while start < ctx.until {
                    if start >= ctx.now {
                        ctx.emit(start, self.signal, Value::Logic(Logic::High));
                    }
                    let fall = start + high;
                    if fall >= ctx.now && fall < ctx.until {
                        ctx.emit(fall, self.signal, Value::Logic(Logic::Low));
                    }
                    start += period;
                }
                // Next step starts in the period that contains `until`.
                let mut keep = self.period_start;
                while keep + period <= ctx.until {
                    keep += period;
                }
                self.period_start = keep;
            }
        }
        ctx.until
    }
    fn controls(&self) -> Vec<String> {
        let mut names = vec![self.control_name("value")];
        if matches!(self.generator, Some(Generator::Pwm { .. })) {
            names.push(self.control_name("duty"));
            names.push(self.control_name("freq_hz"));
        }
        names
    }
    fn control(&mut self, name: &str, value: f64) -> bool {
        let what = name.rsplit('.').next().unwrap_or("");
        match (what, &mut self.generator) {
            ("duty", Some(Generator::Pwm { duty, .. })) => *duty = value,
            ("freq_hz", Some(Generator::Pwm { freq_hz, .. })) => *freq_hz = value,
            ("value", _) => {
                self.value = match self.value {
                    Value::Logic(_) => Value::Real(value).as_logic().into(),
                    Value::Real(_) => Value::Real(value),
                };
                if let Some(Generator::Pwm { duty, .. }) = &mut self.generator {
                    *duty = if value > 0.5 { 1.0 } else { 0.0 };
                }
            }
            _ => return false,
        }
        true
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        match self.generator {
            Some(Generator::Pwm { duty, freq_hz }) => {
                vec![("duty".into(), duty), ("freq_hz".into(), freq_hz)]
            }
            _ => vec![("value".into(), self.value.as_real())],
        }
    }
}

impl From<Logic> for Value {
    fn from(l: Logic) -> Value {
        Value::Logic(l)
    }
}

struct Trace {
    name: String,
    signal: SignalId,
    changes: Vec<Change>,
    next: usize,
}

impl Unit for Trace {
    fn name(&self) -> &str {
        &self.name
    }
    fn domain(&self) -> Domain {
        Domain::Stub
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Producer
    }
    fn reads(&self) -> Vec<SignalId> {
        Vec::new()
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.signal]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        while let Some(change) = self.changes.get(self.next) {
            if change.t >= ctx.until {
                break;
            }
            ctx.emit(change.t.max(ctx.now), self.signal, change.value);
            self.next += 1;
        }
        ctx.until
    }
}

struct Rotor {
    name: String,
    signal: SignalId,
    torque: SignalId,
    inertia: f64,
    damping: f64,
    drag: f64,
    omega: f64,
}

impl Unit for Rotor {
    fn name(&self) -> &str {
        &self.name
    }
    fn domain(&self) -> Domain {
        Domain::Stub
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        vec![self.torque]
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.signal]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        let tau = ctx.real(self.torque);
        // Semi-implicit Euler in 100 µs steps: stable for the stiff damping of small fans.
        let total = (ctx.until - ctx.now).seconds();
        let mut steps = 1u32;
        while f64::from(steps) * 1e-4 < total {
            steps += 1;
        }
        let dt = total / f64::from(steps);
        for _ in 0..steps {
            let resist = self.damping + self.drag * self.omega.abs();
            self.omega = (self.inertia * self.omega + tau * dt) / (self.inertia + resist * dt);
        }
        ctx.set(self.signal, Value::Real(self.omega));
        ctx.until
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        vec![("omega".into(), self.omega)]
    }
}
