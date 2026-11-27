//! A hobby servo (ROADMAP P3-3): its signal pin's pulse width sets a target angle
//! (544–2400 µs for 0–180°, as Arduino's Servo library), and the horn turns
//! toward it at a limited speed. It reads the board pin that drives its signal
//! net, so it sees every edge at its exact time.

use triage_sim_kernel::{
    Domain, SignalBus, SignalId, SignalKind, SimTime, StepContext, Unit, UnitKind, Value,
};

use crate::spec::PartSpec;

/// A servo part.
pub struct ServoUnit {
    name: String,
    signal: SignalId,
    angle: SignalId,
    min_us: f64,
    max_us: f64,
    speed: f64,
    rise: Option<SimTime>,
    level: bool,
    target: f64,
    position: f64,
    pulse_us: f64,
}

impl ServoUnit {
    /// A servo reading `signal` (a board pin's drive).
    pub fn new(part: &PartSpec, signal: SignalId, bus: &mut SignalBus) -> ServoUnit {
        let start = part.param("start_deg", 90.0).to_radians();
        ServoUnit {
            name: part.reference.clone(),
            signal,
            angle: bus.declare(
                &format!("{}.angle", part.reference),
                SignalKind::Real,
                Value::Real(start),
            ),
            min_us: part.param("min_us", 544.0),
            max_us: part.param("max_us", 2400.0),
            speed: part.param("speed_dps", 600.0).to_radians(),
            rise: None,
            level: false,
            target: start,
            position: start,
            pulse_us: 0.0,
        }
    }
}

impl Unit for ServoUnit {
    fn name(&self) -> &str {
        &self.name
    }
    fn domain(&self) -> Domain {
        Domain::Parts
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        vec![self.signal]
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.angle]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        // Steps start at every edge (the kernel syncs at events), so the level now
        // is the level since `ctx.now`.
        let high = ctx.bus.logic(self.signal).is_high();
        if high != self.level {
            let edge = ctx.bus.changed_at(self.signal);
            if high {
                self.rise = Some(edge);
            } else if let Some(rise) = self.rise.take() {
                self.pulse_us = (edge - rise).seconds() * 1e6;
                if (300.0..=3000.0).contains(&self.pulse_us) {
                    let f = ((self.pulse_us - self.min_us) / (self.max_us - self.min_us))
                        .clamp(0.0, 1.0);
                    self.target = f * std::f64::consts::PI;
                }
            }
            self.level = high;
        }
        let max_move = self.speed * (ctx.until - ctx.now).seconds();
        self.position += (self.target - self.position).clamp(-max_move, max_move);
        ctx.set(self.angle, Value::Real(self.position));
        ctx.until
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        vec![
            ("angle_deg".into(), self.position.to_degrees()),
            ("pulse_us".into(), self.pulse_us),
        ]
    }
}
