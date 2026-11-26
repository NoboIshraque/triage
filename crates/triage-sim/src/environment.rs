//! The environment unit: room temperature, set by a slider (`env.room_temperature_c`)
//! or following a scenario's piecewise-linear profile.

use triage_sim_kernel::{
    Domain, SignalBus, SignalId, SignalKind, SimTime, StepContext, Unit, UnitKind, Value,
};

use crate::spec::EnvironmentSpec;

/// The environment.
pub struct EnvironmentUnit {
    temperature: SignalId,
    /// A slider's value, once moved (it wins over the profile).
    fixed: Option<f64>,
    start: f64,
    profile: Vec<(f64, f64)>,
}

impl EnvironmentUnit {
    /// The environment of a device.
    pub fn new(spec: &EnvironmentSpec, bus: &mut SignalBus) -> EnvironmentUnit {
        let temperature = bus.declare(
            "env:temperature_c",
            SignalKind::Real,
            Value::Real(spec.room_temperature_c),
        );
        let mut profile = spec.temperature_profile.clone();
        profile.sort_by(|a, b| a.0.total_cmp(&b.0));
        let unit = EnvironmentUnit {
            temperature,
            fixed: None,
            start: spec.room_temperature_c,
            profile,
        };
        bus.set(temperature, SimTime::ZERO, Value::Real(unit.at(0.0)));
        unit
    }

    /// The room temperature at `t` seconds.
    #[must_use]
    pub fn at(&self, t: f64) -> f64 {
        if let Some(v) = self.fixed {
            return v;
        }
        let Some(&(t0, v0)) = self.profile.first() else {
            return self.start;
        };
        if t <= t0 {
            return v0;
        }
        for pair in self.profile.windows(2) {
            let ((ta, va), (tb, vb)) = (pair[0], pair[1]);
            if t <= tb {
                return if tb > ta {
                    va + (vb - va) * (t - ta) / (tb - ta)
                } else {
                    vb
                };
            }
        }
        self.profile.last().map_or(self.start, |p| p.1)
    }
}

impl Unit for EnvironmentUnit {
    fn name(&self) -> &'static str {
        "environment"
    }
    fn domain(&self) -> Domain {
        Domain::Environment
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        Vec::new()
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.temperature]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        let value = self.at(ctx.until.seconds());
        ctx.set(self.temperature, Value::Real(value));
        ctx.until
    }
    fn controls(&self) -> Vec<String> {
        vec!["env.room_temperature_c".into()]
    }
    fn control(&mut self, _name: &str, value: f64) -> bool {
        self.fixed = Some(value);
        true
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        vec![(
            "room_temperature_c".into(),
            self.fixed.unwrap_or(self.start),
        )]
    }
}
