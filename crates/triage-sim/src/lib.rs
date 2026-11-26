//! Triage's simulated device (ROADMAP P3-3 to P3-5, PLAN §4.7): turns a device
//! description ([`spec::DeviceSpec`], written from the project's link graph) and
//! a scope into a running kernel.
//!
//! - [`circuit`]: the T0 circuit, partitioned into rails, logic nets and analog
//!   islands solved by `triage-mna`; parts: resistor, NTC thermistor, pot, button,
//!   LED, diode, logic-level MOSFET, DC motor, capacitor, inductor, and the supply
//!   draw of bus devices (the SSD1306 display's bus side is in the AVR unit).
//! - [`servo`]: a hobby servo driven by pulse width.
//! - [`mechanics`]: bodies turned by motors, stepped by MuJoCo.
//! - [`environment`]: room temperature from a slider or a scenario's profile.
//! - [`device`]: builds all of it for a scope, with the MCU as a kernel host.

pub mod circuit;
pub mod device;
pub mod environment;
pub mod mechanics;
pub mod servo;
pub mod spec;

pub use device::{BuildOptions, BuiltDevice, DeviceInfo, build};
pub use spec::DeviceSpec;
