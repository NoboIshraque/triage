//! MuJoCo for Triage's mechanics unit (ROADMAP P3-4, PLAN §4.7).
//!
//! A [`World`] holds rotors: a disc on a hinge with a motor, built with MuJoCo's
//! `mjs_*` model API (no XML). Each step, MuJoCo's `mjcb_control` callback sets
//! every motor to its rotor's torque minus its air drag. The C shim
//! (`shim/triage_mujoco.c`) is the only code that touches MuJoCo's structs.
// Calling MuJoCo's C library through the shim is FFI, which is unsafe code.
#![allow(unsafe_code)]

use std::ffi::{CStr, c_char, c_double, c_int};
use std::fmt;

#[repr(C)]
struct RawWorld {
    _private: [u8; 0],
}

#[cfg(not(triage_no_mujoco))]
unsafe extern "C" {
    fn tm_world_new(
        rotors: c_int,
        radius: *const c_double,
        mass: *const c_double,
        damping: *const c_double,
        drag: *const c_double,
        timestep: c_double,
        error: *mut c_char,
        error_size: c_int,
    ) -> *mut RawWorld;
    fn tm_world_free(world: *mut RawWorld);
    fn tm_set_torque(world: *mut RawWorld, rotor: c_int, torque: c_double);
    fn tm_step(world: *mut RawWorld, steps: c_int);
    fn tm_time(world: *const RawWorld) -> c_double;
    fn tm_timestep(world: *const RawWorld) -> c_double;
    fn tm_angle(world: *const RawWorld, rotor: c_int) -> c_double;
    fn tm_omega(world: *const RawWorld, rotor: c_int) -> c_double;
    fn tm_inertia(world: *const RawWorld, rotor: c_int) -> c_double;
    fn tm_version() -> *const c_char;
}

#[cfg(triage_no_mujoco)]
mod missing {
    //! Stand-ins when MuJoCo isn't built: `World::new` fails first, so none of
    //! the others is ever called.
    use super::{RawWorld, c_char, c_double, c_int};
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn tm_world_new(
        _: c_int,
        _: *const c_double,
        _: *const c_double,
        _: *const c_double,
        _: *const c_double,
        _: c_double,
        _: *mut c_char,
        _: c_int,
    ) -> *mut RawWorld {
        std::ptr::null_mut()
    }
    pub unsafe fn tm_world_free(_: *mut RawWorld) {}
    pub unsafe fn tm_set_torque(_: *mut RawWorld, _: c_int, _: c_double) {}
    pub unsafe fn tm_step(_: *mut RawWorld, _: c_int) {}
    pub unsafe fn tm_time(_: *const RawWorld) -> c_double {
        0.0
    }
    pub unsafe fn tm_timestep(_: *const RawWorld) -> c_double {
        0.0
    }
    pub unsafe fn tm_angle(_: *const RawWorld, _: c_int) -> c_double {
        0.0
    }
    pub unsafe fn tm_omega(_: *const RawWorld, _: c_int) -> c_double {
        0.0
    }
    pub unsafe fn tm_inertia(_: *const RawWorld, _: c_int) -> c_double {
        0.0
    }
    pub unsafe fn tm_version() -> *const c_char {
        c"none".as_ptr()
    }
}
#[cfg(triage_no_mujoco)]
use missing::{
    tm_angle, tm_inertia, tm_omega, tm_set_torque, tm_step, tm_time, tm_timestep, tm_version,
    tm_world_free, tm_world_new,
};

/// Whether this build links MuJoCo.
#[must_use]
pub fn available() -> bool {
    cfg!(not(triage_no_mujoco))
}

/// A rotor: a disc of `radius` and `mass` on a hinge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rotor {
    /// Disc radius, m.
    pub radius: f64,
    /// Mass, kg.
    pub mass: f64,
    /// Bearing friction, N·m·s/rad.
    pub damping: f64,
    /// Air drag `c·ω·|ω|`, N·m·s²/rad².
    pub drag: f64,
}

/// MuJoCo refused to build the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MujocoError(pub String);

impl fmt::Display for MujocoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MuJoCo: {}", self.0)
    }
}

impl std::error::Error for MujocoError {}

/// A MuJoCo model and its data.
pub struct World {
    raw: *mut RawWorld,
    rotors: usize,
}

impl World {
    /// Builds a world of rotors, stepped every `timestep` seconds.
    ///
    /// # Errors
    /// When MuJoCo can't compile the model.
    pub fn new(rotors: &[Rotor], timestep: f64) -> Result<World, MujocoError> {
        let radius: Vec<f64> = rotors.iter().map(|r| r.radius).collect();
        let mass: Vec<f64> = rotors.iter().map(|r| r.mass).collect();
        let damping: Vec<f64> = rotors.iter().map(|r| r.damping).collect();
        let drag: Vec<f64> = rotors.iter().map(|r| r.drag).collect();
        let count =
            c_int::try_from(rotors.len()).map_err(|_| MujocoError("too many rotors".into()))?;
        let mut error = [0 as c_char; 512];
        // SAFETY: every array has `count` elements; `error` is writable for its size.
        let raw = unsafe {
            tm_world_new(
                count,
                radius.as_ptr(),
                mass.as_ptr(),
                damping.as_ptr(),
                drag.as_ptr(),
                timestep,
                error.as_mut_ptr(),
                512,
            )
        };
        if raw.is_null() {
            if !available() {
                return Err(MujocoError(
                    "this build has no MuJoCo: run `node engines/mujoco/build.mjs`, then rebuild"
                        .into(),
                ));
            }
            // SAFETY: the shim wrote a NUL-terminated message into `error`.
            let message = unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            return Err(MujocoError(message));
        }
        Ok(World {
            raw,
            rotors: rotors.len(),
        })
    }

    fn index(&self, rotor: usize) -> c_int {
        assert!(rotor < self.rotors, "rotor {rotor} of {}", self.rotors);
        c_int::try_from(rotor).unwrap_or(0)
    }

    /// Sets a rotor's motor torque, N·m, for the next steps.
    pub fn set_torque(&mut self, rotor: usize, torque: f64) {
        let i = self.index(rotor);
        // SAFETY: `raw` is a live world and `i` is in range.
        unsafe { tm_set_torque(self.raw, i, torque) }
    }

    /// Takes `steps` MuJoCo steps.
    pub fn step(&mut self, steps: u32) {
        let steps = c_int::try_from(steps).unwrap_or(c_int::MAX);
        // SAFETY: `raw` is a live world.
        unsafe { tm_step(self.raw, steps) }
    }

    /// MuJoCo's time, s.
    #[must_use]
    pub fn time(&self) -> f64 {
        // SAFETY: `raw` is a live world.
        unsafe { tm_time(self.raw) }
    }

    /// The model's timestep, s.
    #[must_use]
    pub fn timestep(&self) -> f64 {
        // SAFETY: `raw` is a live world.
        unsafe { tm_timestep(self.raw) }
    }

    /// A rotor's angle, rad.
    #[must_use]
    pub fn angle(&self, rotor: usize) -> f64 {
        let i = self.index(rotor);
        // SAFETY: `raw` is a live world and `i` is in range.
        unsafe { tm_angle(self.raw, i) }
    }

    /// A rotor's speed, rad/s.
    #[must_use]
    pub fn omega(&self, rotor: usize) -> f64 {
        let i = self.index(rotor);
        // SAFETY: `raw` is a live world and `i` is in range.
        unsafe { tm_omega(self.raw, i) }
    }

    /// A rotor's moment of inertia about its hinge, as MuJoCo computed it, kg·m².
    #[must_use]
    pub fn inertia(&self, rotor: usize) -> f64 {
        let i = self.index(rotor);
        // SAFETY: `raw` is a live world and `i` is in range.
        unsafe { tm_inertia(self.raw, i) }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        // SAFETY: `raw` came from tm_world_new and is freed once.
        unsafe { tm_world_free(self.raw) }
    }
}

/// MuJoCo's version string.
#[must_use]
pub fn version() -> String {
    // SAFETY: MuJoCo returns a static NUL-terminated string.
    unsafe { CStr::from_ptr(tm_version()) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg_attr(triage_no_mujoco, ignore = "MuJoCo isn't built")]
    fn a_rotor_spins_up_as_its_dynamics_say() {
        assert_eq!(version(), "4.0.1");
        let rotor = Rotor {
            radius: 0.035,
            mass: 0.03,
            damping: 1e-5,
            drag: 0.0,
        };
        let mut world = World::new(&[rotor], 0.001).unwrap();
        // A solid disc: J = m r² / 2.
        let j = 0.5 * 0.03 * 0.035 * 0.035;
        assert!(
            (world.inertia(0) - j).abs() / j < 1e-6,
            "{} vs {j}",
            world.inertia(0)
        );
        // Constant torque against viscous damping: ω(t) = τ/b · (1 − e^(−b t / J)).
        world.set_torque(0, 1e-4);
        world.step(1000);
        let expected = 1e-4 / 1e-5 * (1.0 - (-1e-5 * 1.0 / j).exp());
        assert!((world.time() - 1.0).abs() < 1e-9);
        assert!(
            (world.omega(0) - expected).abs() / expected < 0.01,
            "{} vs {expected}",
            world.omega(0)
        );
        assert!(world.angle(0) > 0.0);
    }

    #[test]
    #[cfg_attr(triage_no_mujoco, ignore = "MuJoCo isn't built")]
    fn drag_limits_the_speed() {
        // τ = c ω² at steady state: 1e-3 = 1e-7 ω² → ω = 100 rad/s.
        let rotor = Rotor {
            radius: 0.03,
            mass: 0.01,
            damping: 0.0,
            drag: 1e-7,
        };
        let mut world = World::new(&[rotor, rotor], 0.001).unwrap();
        world.set_torque(0, 1e-3);
        world.set_torque(1, -1e-3);
        world.step(5000);
        assert!((world.omega(0) - 100.0).abs() < 0.5, "{}", world.omega(0));
        assert!((world.omega(1) + 100.0).abs() < 0.5, "{}", world.omega(1));
    }
}
