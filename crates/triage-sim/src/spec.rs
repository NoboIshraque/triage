//! The device description the simulation is built from. Triage writes it from the
//! project's link graph (`.triage/links.json`: the schematic's components and
//! nets, from KiCad's engine), `simulation/parts.toml` (models for parts the
//! schematic can't describe, such as the fan on a header) and the environment.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A whole device.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceSpec {
    /// The project's name.
    #[serde(default)]
    pub name: String,
    /// The ground net.
    pub ground: String,
    /// The microcontroller board, if the device has one.
    #[serde(default)]
    pub board: Option<BoardSpec>,
    /// Every other part.
    #[serde(default)]
    pub parts: Vec<PartSpec>,
    /// Room temperature and supplies.
    #[serde(default)]
    pub environment: EnvironmentSpec,
    /// Bodies driven by parts (a fan's rotor on a motor).
    #[serde(default)]
    pub mechanics: Vec<BodySpec>,
}

/// The MCU board (an Arduino Uno): its I/O pins and its supply pins.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BoardSpec {
    /// Reference, for example `A1`.
    pub reference: String,
    /// Board profile, for example `arduino-uno`.
    pub profile: String,
    /// I/O pins that connect to a net.
    pub pins: Vec<BoardPin>,
    /// The regulator's output (`+5V`) and its voltage; the board drives this net.
    #[serde(default)]
    pub regulator: Option<RailPin>,
    /// The net the board is powered from (`VIN`), which carries its draw.
    #[serde(default)]
    pub vin: Option<String>,
    /// The board's own draw, A (default 0.045 for an Uno).
    #[serde(default)]
    pub quiescent_a: Option<f64>,
}

/// One I/O pin of the board.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BoardPin {
    /// The board's name for it (`D9`, `A0`).
    pub name: String,
    /// The net it connects to.
    pub net: String,
    /// Whether the firmware can read it with the ADC.
    #[serde(default)]
    pub analog: bool,
    /// Whether it has a PWM output (`analogWrite`).
    #[serde(default)]
    pub pwm: bool,
}

/// A rail a part holds at a voltage.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RailPin {
    /// The net.
    pub net: String,
    /// Its voltage.
    pub volts: f64,
}

/// A part, with its model, parameters and pins.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PartSpec {
    /// Reference, for example `R1`.
    pub reference: String,
    /// `resistor`, `ntc`, `pot`, `button`, `led`, `diode`, `nmos`, `dc-motor`,
    /// `servo`, `supply`, `ssd1306` (a bus device: only its supply draw is in the
    /// circuit) or `none`.
    pub model: String,
    /// Model parameters (SI units).
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
    /// The model's pin names (`a`, `b`, `anode`, `cathode`, `d`, `g`, `s`, `+`, `-`,
    /// `wiper`, `signal`, `vcc`, `gnd`, `scl`, `sda`) and the nets they connect to.
    pub pins: BTreeMap<String, String>,
}

impl PartSpec {
    /// A parameter, or its default.
    #[must_use]
    pub fn param(&self, name: &str, default: f64) -> f64 {
        self.params.get(name).copied().unwrap_or(default)
    }

    /// The net on one of the model's pins.
    #[must_use]
    pub fn net(&self, pin: &str) -> Option<&str> {
        self.pins
            .get(pin)
            .map(String::as_str)
            .filter(|n| !n.is_empty())
    }
}

/// The environment: room temperature now and over time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnvironmentSpec {
    /// Room temperature at the start, °C.
    pub room_temperature_c: f64,
    /// A piecewise-linear temperature profile, `(seconds, °C)` (a scenario's ramp).
    #[serde(default)]
    pub temperature_profile: Vec<(f64, f64)>,
}

impl Default for EnvironmentSpec {
    fn default() -> EnvironmentSpec {
        EnvironmentSpec {
            room_temperature_c: 24.0,
            temperature_profile: Vec::new(),
        }
    }
}

/// A rigid body on a hinge, turned by a motor part (a fan's rotor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BodySpec {
    /// Its name (`rotor`), also the 3D object it moves.
    pub name: String,
    /// The motor part that drives it (`J1`).
    pub driven_by: String,
    /// Radius of the disc that stands for its inertia, m.
    #[serde(default = "default_radius")]
    pub radius_m: f64,
    /// Its mass, kg.
    #[serde(default = "default_mass")]
    pub mass_kg: f64,
    /// Bearing friction, N·m·s/rad.
    #[serde(default = "default_damping")]
    pub damping: f64,
    /// Aerodynamic load `c·ω·|ω|`, N·m·s²/rad² (a fan's air).
    #[serde(default = "default_drag")]
    pub drag: f64,
    /// The 3D view's object it moves (`fan.FCStd#Body`), if any.
    #[serde(default)]
    pub object: Option<String>,
    /// The hinge's axis in the object's frame.
    #[serde(default = "default_axis")]
    pub axis: [f64; 3],
    /// A point on the axis, m, in the object's frame.
    #[serde(default)]
    pub origin: [f64; 3],
}

fn default_radius() -> f64 {
    0.035
}
fn default_mass() -> f64 {
    0.03
}
fn default_damping() -> f64 {
    2e-6
}
fn default_drag() -> f64 {
    5e-8
}
fn default_axis() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}
