//! The mechanics unit (ROADMAP P3-4): bodies turned by motor parts. Each body
//! reads its motor's torque (`J1.torque`) and writes its speed (`J1.omega`, the
//! motor's back-EMF) and angle (`body:rotor.angle`, for the 3D view).
//!
//! With the `mujoco` feature, MuJoCo steps the bodies at 1 kHz (PLAN §4.7);
//! without it a built-in integrator of the same equations runs, so development
//! builds without MuJoCo still simulate the mechanism.

use triage_sim_kernel::{
    Domain, SignalBus, SignalId, SignalKind, SimTime, StepContext, Unit, UnitKind, Value,
};

use crate::spec::BodySpec;

/// MuJoCo's timestep, s (1 kHz).
pub const TIMESTEP: f64 = 0.001;

enum Backend {
    #[cfg(feature = "mujoco")]
    Mujoco(triage_mujoco::World),
    Builtin {
        inertia: Vec<f64>,
        omega: Vec<f64>,
        angle: Vec<f64>,
        torque: Vec<f64>,
    },
}

struct Body {
    torque: SignalId,
    omega: SignalId,
    angle: SignalId,
    damping: f64,
    drag: f64,
}

/// The mechanics unit.
pub struct MechanicsUnit {
    bodies: Vec<Body>,
    backend: Backend,
    /// Time not yet stepped (MuJoCo steps whole timesteps).
    pending: f64,
}

/// The inertia of a solid disc, kg·m².
#[must_use]
pub fn disc_inertia(spec: &BodySpec) -> f64 {
    0.5 * spec.mass_kg * spec.radius_m * spec.radius_m
}

impl MechanicsUnit {
    /// The bodies of a device.
    ///
    /// # Errors
    /// When MuJoCo can't build the model.
    pub fn new(
        specs: &[BodySpec],
        bus: &mut SignalBus,
        use_mujoco: bool,
    ) -> Result<MechanicsUnit, String> {
        let bodies: Vec<Body> = specs
            .iter()
            .map(|b| Body {
                torque: bus.declare(
                    &format!("{}.torque", b.driven_by),
                    SignalKind::Real,
                    Value::Real(0.0),
                ),
                omega: bus.declare(
                    &format!("{}.omega", b.driven_by),
                    SignalKind::Real,
                    Value::Real(0.0),
                ),
                angle: bus.declare(
                    &format!("body:{}.angle", b.name),
                    SignalKind::Real,
                    Value::Real(0.0),
                ),
                damping: b.damping,
                drag: b.drag,
            })
            .collect();
        let builtin = || Backend::Builtin {
            inertia: specs.iter().map(disc_inertia).collect(),
            omega: vec![0.0; specs.len()],
            angle: vec![0.0; specs.len()],
            torque: vec![0.0; specs.len()],
        };
        let backend = if use_mujoco {
            mujoco_backend(specs)?
        } else {
            builtin()
        };
        Ok(MechanicsUnit {
            bodies,
            backend,
            pending: 0.0,
        })
    }

    /// Which engine steps the bodies.
    #[must_use]
    pub fn engine(&self) -> &'static str {
        match self.backend {
            #[cfg(feature = "mujoco")]
            Backend::Mujoco(_) => "mujoco",
            Backend::Builtin { .. } => "builtin",
        }
    }

    fn omega(&self, i: usize) -> f64 {
        match &self.backend {
            #[cfg(feature = "mujoco")]
            Backend::Mujoco(world) => world.omega(i),
            Backend::Builtin { omega, .. } => omega[i],
        }
    }

    fn angle(&self, i: usize) -> f64 {
        match &self.backend {
            #[cfg(feature = "mujoco")]
            Backend::Mujoco(world) => world.angle(i),
            Backend::Builtin { angle, .. } => angle[i],
        }
    }
}

#[cfg(feature = "mujoco")]
fn mujoco_backend(specs: &[BodySpec]) -> Result<Backend, String> {
    let rotors: Vec<triage_mujoco::Rotor> = specs
        .iter()
        .map(|b| triage_mujoco::Rotor {
            radius: b.radius_m,
            mass: b.mass_kg,
            damping: b.damping,
            drag: b.drag,
        })
        .collect();
    triage_mujoco::World::new(&rotors, TIMESTEP)
        .map(Backend::Mujoco)
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "mujoco"))]
fn mujoco_backend(_specs: &[BodySpec]) -> Result<Backend, String> {
    Err("this build has no MuJoCo (the sim addon was built without the \"mujoco\" feature)".into())
}

/// Whether this build carries MuJoCo.
#[must_use]
pub fn has_mujoco() -> bool {
    cfg!(feature = "mujoco")
}

impl Unit for MechanicsUnit {
    fn name(&self) -> &'static str {
        "mechanics"
    }
    fn domain(&self) -> Domain {
        Domain::Mechanics
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        self.bodies.iter().map(|b| b.torque).collect()
    }
    fn writes(&self) -> Vec<SignalId> {
        self.bodies
            .iter()
            .flat_map(|b| [b.omega, b.angle])
            .collect()
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        self.pending += (ctx.until - ctx.now).seconds();
        let mut steps = 0u32;
        while self.pending >= TIMESTEP * (1.0 - 1e-9) {
            self.pending -= TIMESTEP;
            steps += 1;
        }
        if steps > 0 {
            let torques: Vec<f64> = self.bodies.iter().map(|b| ctx.real(b.torque)).collect();
            match &mut self.backend {
                #[cfg(feature = "mujoco")]
                Backend::Mujoco(world) => {
                    for (i, &t) in torques.iter().enumerate() {
                        world.set_torque(i, t);
                    }
                    world.step(steps);
                }
                Backend::Builtin {
                    inertia,
                    omega,
                    angle,
                    torque,
                } => {
                    for (i, body) in self.bodies.iter().enumerate() {
                        torque[i] = torques[i];
                        for _ in 0..steps {
                            // Implicit in velocity (as MuJoCo's implicitfast): stable for stiff damping.
                            let resist = body.damping + body.drag * omega[i].abs();
                            omega[i] = (inertia[i] * omega[i] + torques[i] * TIMESTEP)
                                / (inertia[i] + resist * TIMESTEP);
                            angle[i] += omega[i] * TIMESTEP;
                        }
                    }
                }
            }
        }
        for i in 0..self.bodies.len() {
            let (omega, angle) = (self.omega(i), self.angle(i));
            ctx.set(self.bodies[i].omega, Value::Real(omega));
            ctx.set(self.bodies[i].angle, Value::Real(angle));
        }
        ctx.until
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        (0..self.bodies.len())
            .map(|i| {
                (
                    format!("body{i}.rpm"),
                    self.omega(i) * 60.0 / std::f64::consts::TAU,
                )
            })
            .collect()
    }
}
