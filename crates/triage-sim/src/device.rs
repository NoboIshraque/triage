//! Builds a simulated device for a scope: the units (environment, circuit,
//! mechanics, servos), the MCU board as a host (the AVR emulator runs outside
//! Rust), the default stub for every signal a scope can cut, and the virtual I/O
//! panel that stands in for the circuit when only the code runs.

use std::collections::BTreeMap;

use serde::Serialize;
use triage_sim_kernel::{
    Domain, Generator, HostSpec, IdealModel, Kernel, KernelConfig, Logic, Scope, SignalBus,
    SignalKind, SimTime, StubInfo, StubSpec, Unit, Value, cut,
};

use crate::circuit::{CircuitUnit, drive_signal, net_signal};
use crate::environment::EnvironmentUnit;
use crate::mechanics::{MechanicsUnit, disc_inertia};
use crate::servo::ServoUnit;
use crate::spec::{BodySpec, DeviceSpec};

/// How to build.
#[derive(Clone, Debug)]
pub struct BuildOptions {
    /// Scheduler settings.
    pub config: KernelConfig,
    /// Step the mechanism with MuJoCo (needs the `mujoco` feature).
    pub mujoco: bool,
    /// Trace every signal (for plots and scenario checks).
    pub trace_all: bool,
}

impl Default for BuildOptions {
    fn default() -> BuildOptions {
        BuildOptions {
            config: KernelConfig::default(),
            mujoco: crate::mechanics::has_mujoco(),
            trace_all: true,
        }
    }
}

/// One I/O pin of the MCU host.
#[derive(Clone, Debug, Serialize)]
pub struct HostPin {
    /// `D9`, `A0`.
    pub name: String,
    /// Its net.
    pub net: String,
    /// Readable by the ADC.
    pub analog: bool,
    /// The signal it drives (the host writes it).
    pub drive: u32,
    /// The net's voltage (the host reads it).
    pub voltage: u32,
}

/// The MCU board, run by the caller as a kernel host.
#[derive(Clone, Debug, Serialize)]
pub struct HostInfo {
    /// The kernel's host index.
    pub host: u32,
    /// Board reference (`A1`).
    pub reference: String,
    /// Board profile (`arduino-uno`).
    pub profile: String,
    /// Its pins.
    pub pins: Vec<HostPin>,
}

/// An element of the virtual I/O panel (code-only runs).
#[derive(Clone, Debug, Serialize)]
pub struct IoElement {
    /// `button`, `slider` or `indicator`.
    pub kind: &'static str,
    /// What to show.
    pub label: String,
    /// The control it sets (`net:/BUTTON.value`), for buttons and sliders.
    pub control: Option<String>,
    /// The signal it shows (a pin's drive), for indicators.
    pub signal: Option<String>,
    /// Slider range and starting value, V.
    pub min: f64,
    /// Slider maximum.
    pub max: f64,
    /// Starting value (a button's released voltage).
    pub value: f64,
    /// A button's pressed voltage.
    pub pressed: f64,
}

/// A body the 3D view moves.
#[derive(Clone, Debug, Serialize)]
pub struct BodyInfo {
    /// Its name.
    pub name: String,
    /// The 3D object.
    pub object: Option<String>,
    /// Hinge axis and origin in the object's frame.
    pub axis: [f64; 3],
    /// A point on the axis, m.
    pub origin: [f64; 3],
    /// The signal with its angle.
    pub angle: String,
    /// The signal with its speed, rad/s.
    pub omega: String,
}

/// What the caller needs to run and show a device.
#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfo {
    /// The scope's name.
    pub scope: String,
    /// Units that run: name, domain, kind.
    pub units: Vec<(String, String, String)>,
    /// The MCU host, if the scope runs the firmware.
    pub hosts: Vec<HostInfo>,
    /// Stubs at the scope's boundary.
    pub stubs: Vec<StubInfo>,
    /// Units the scope leaves out.
    pub left_out: Vec<String>,
    /// Controls the units accept.
    pub controls: Vec<String>,
    /// The virtual I/O panel (when the circuit doesn't run).
    pub io_panel: Vec<IoElement>,
    /// Every signal: name and kind, by id.
    pub signals: Vec<(String, SignalKind)>,
    /// Bodies for the 3D view.
    pub bodies: Vec<BodyInfo>,
    /// LEDs: reference and brightness signal.
    pub leds: Vec<(String, String)>,
    /// `mujoco`, `builtin`, or `none`.
    pub mechanics_engine: &'static str,
}

/// A device ready to run.
pub struct BuiltDevice {
    /// The kernel.
    pub kernel: Kernel,
    /// What runs and how.
    pub info: DeviceInfo,
}

/// The models of the parts on a net.
fn models_on<'a>(spec: &'a DeviceSpec, net: &str) -> Vec<&'a str> {
    spec.parts
        .iter()
        .filter(|p| p.pins.values().any(|n| n == net))
        .map(|p| p.model.as_str())
        .collect()
}

/// Resolves the names a scope file may use for a signal: `net:FAN_PWM` (the board
/// pin driving it, else the net's voltage), `pin:D9`, `part:J1` (a motor's shaft).
fn resolve(spec: &DeviceSpec, bus: &SignalBus, name: &str) -> String {
    if bus.id(name).is_some() {
        return name.to_owned();
    }
    if let Some(net) = name.strip_prefix("net:") {
        let candidates = [net.to_owned(), format!("/{net}")];
        if let Some(board) = &spec.board {
            for net in &candidates {
                if let Some(pin) = board.pins.iter().find(|p| &p.net == net) {
                    return drive_signal(&board.reference, &pin.name);
                }
            }
        }
        for net in &candidates {
            if bus.id(&net_signal(net)).is_some() {
                return net_signal(net);
            }
        }
    }
    if let (Some(pin), Some(board)) = (name.strip_prefix("pin:"), &spec.board) {
        return drive_signal(&board.reference, pin);
    }
    if let Some(part) = name.strip_prefix("part:") {
        return format!("{part}.omega");
    }
    name.to_owned()
}

/// Builds a device for a scope.
///
/// # Errors
/// For a device description the circuit or MuJoCo can't build, or a scope that
/// doesn't fit the device.
#[allow(clippy::too_many_lines)]
pub fn build(
    spec: &DeviceSpec,
    scope: &Scope,
    options: &BuildOptions,
) -> Result<BuiltDevice, String> {
    let mut bus = SignalBus::new();
    let mut units: Vec<Box<dyn Unit>> = Vec::new();
    // Environment first: in each coupling step every unit reads what the ones
    // before it wrote (Gauss–Seidel), and the circuit reads the temperature.
    units.push(Box::new(EnvironmentUnit::new(&spec.environment, &mut bus)));
    let has_circuit = spec
        .parts
        .iter()
        .any(|p| !matches!(p.model.as_str(), "none"))
        || spec.board.is_some();
    if has_circuit {
        units.push(Box::new(CircuitUnit::new(spec, &mut bus)?));
    }
    let mut mechanics_engine = "none";
    if !spec.mechanics.is_empty() {
        let mechanics = MechanicsUnit::new(&spec.mechanics, &mut bus, options.mujoco)?;
        mechanics_engine = mechanics.engine();
        units.push(Box::new(mechanics));
    }
    if let Some(board) = &spec.board {
        for part in spec.parts.iter().filter(|p| p.model == "servo") {
            let net = part
                .net("signal")
                .ok_or_else(|| format!("{}: a servo needs a signal pin", part.reference))?;
            let pin = board.pins.iter().find(|p| p.net == net).ok_or_else(|| {
                format!(
                    "{}: no board pin drives its signal net {net}",
                    part.reference
                )
            })?;
            let signal = bus.declare(
                &drive_signal(&board.reference, &pin.name),
                SignalKind::Logic,
                Value::Logic(Logic::Z),
            );
            units.push(Box::new(ServoUnit::new(part, signal, &mut bus)));
        }
    }

    // The board as a host: it reads its nets' voltages and drives its pins.
    let mut hosts = Vec::new();
    let mut host_pins = Vec::new();
    let mut defaults: BTreeMap<String, StubSpec> = BTreeMap::new();
    let mut io_panel = Vec::new();
    if let Some(board) = &spec.board {
        let vcc = board.regulator.as_ref().map_or(5.0, |r| r.volts);
        let mut reads = Vec::new();
        let mut writes = Vec::new();
        for pin in &board.pins {
            let drive = bus.declare(
                &drive_signal(&board.reference, &pin.name),
                SignalKind::Logic,
                Value::Logic(Logic::Z),
            );
            let voltage = bus.declare(&net_signal(&pin.net), SignalKind::Real, Value::Real(0.0));
            reads.push(voltage);
            writes.push(drive);
            host_pins.push(HostPin {
                name: pin.name.clone(),
                net: pin.net.clone(),
                analog: pin.analog,
                drive: drive.0,
                voltage: voltage.0,
            });

            let models = models_on(spec, &pin.net);
            let label = format!("{} ({})", pin.net.trim_start_matches('/'), pin.name);
            let now = bus.real(voltage);
            // Code only: the net's voltage follows the virtual I/O panel.
            defaults.insert(
                net_signal(&pin.net),
                StubSpec::Control {
                    value: Value::Real(now),
                    generator: None,
                },
            );
            let drive_default = if models.contains(&"button") {
                io_panel.push(IoElement {
                    kind: "button",
                    label,
                    control: Some(format!("{}.value", net_signal(&pin.net))),
                    signal: None,
                    min: 0.0,
                    max: vcc,
                    value: vcc,
                    pressed: 0.0,
                });
                defaults.insert(
                    net_signal(&pin.net),
                    StubSpec::Control {
                        value: Value::Real(vcc),
                        generator: None,
                    },
                );
                StubSpec::Control {
                    value: Value::Logic(Logic::WeakHigh),
                    generator: None,
                }
            } else if models.iter().any(|m| matches!(*m, "ntc" | "pot"))
                || (pin.analog && models.is_empty())
            {
                io_panel.push(IoElement {
                    kind: "slider",
                    label,
                    control: Some(format!("{}.value", net_signal(&pin.net))),
                    signal: None,
                    min: 0.0,
                    max: vcc,
                    value: now,
                    pressed: 0.0,
                });
                StubSpec::Open
            } else if models.iter().any(|m| matches!(*m, "ssd1306")) {
                StubSpec::Hold {
                    value: Value::Logic(Logic::WeakHigh),
                }
            } else {
                io_panel.push(IoElement {
                    kind: "indicator",
                    label,
                    control: None,
                    signal: Some(drive_signal(&board.reference, &pin.name)),
                    min: 0.0,
                    max: 1.0,
                    value: 0.0,
                    pressed: 0.0,
                });
                // Circuit only: an output pin is a PWM generator the user can set.
                let generator = pin.pwm.then_some(Generator::Pwm {
                    duty: 0.5,
                    freq_hz: 490.0,
                });
                StubSpec::Control {
                    value: Value::Logic(Logic::Low),
                    generator,
                }
            };
            defaults.insert(drive_signal(&board.reference, &pin.name), drive_default);
        }
        hosts.push(HostSpec {
            name: format!("mcu:{}", board.reference),
            domain: Domain::Firmware,
            reads,
            writes,
        });
    }

    // Mechanism left out: an ideal rotor with the body's inertia. Circuit left out:
    // the torque is a control. Environment left out: the temperature is a control.
    let default_body = BodySpec {
        name: String::new(),
        driven_by: String::new(),
        radius_m: 0.035,
        mass_kg: 0.03,
        damping: 2e-6,
        drag: 5e-8,
        object: None,
        axis: [0.0, 0.0, 1.0],
        origin: [0.0; 3],
    };
    for part in spec.parts.iter().filter(|p| p.model == "dc-motor") {
        let body = spec
            .mechanics
            .iter()
            .find(|b| b.driven_by == part.reference)
            .unwrap_or(&default_body);
        defaults.insert(
            format!("{}.omega", part.reference),
            StubSpec::Ideal {
                model: IdealModel::Rotor {
                    inertia: disc_inertia(body),
                    damping: body.damping,
                    drag: body.drag,
                },
                reads: Some(format!("{}.torque", part.reference)),
            },
        );
        defaults.insert(
            format!("{}.torque", part.reference),
            StubSpec::Control {
                value: Value::Real(0.0),
                generator: None,
            },
        );
    }
    defaults.insert(
        "env:temperature_c".into(),
        StubSpec::Control {
            value: Value::Real(spec.environment.room_temperature_c),
            generator: None,
        },
    );

    // The scope may name signals the way scope files do.
    let mut scope = scope.clone();
    scope.stubs = scope
        .stubs
        .into_iter()
        .map(|(name, stub)| (resolve(spec, &bus, &name), stub))
        .collect();
    for stub in scope.stubs.values_mut() {
        if let StubSpec::Ideal {
            reads: Some(reads), ..
        } = stub
        {
            *reads = resolve(spec, &bus, reads);
        }
    }
    let mut cut = cut(&mut bus, units, hosts, &scope, &defaults)?;
    // The I/O panel only matters where its controls exist.
    let stubbed: Vec<&str> = cut.stubs.iter().map(|s| s.signal.as_str()).collect();
    io_panel.retain(|e| match (&e.control, &e.signal) {
        (Some(control), _) => stubbed
            .iter()
            .any(|s| control.starts_with(&format!("{s}."))),
        (None, Some(_)) => stubbed.iter().any(|s| s.starts_with("net:")),
        _ => false,
    });

    let host_infos: Vec<HostInfo> = cut
        .hosts
        .iter()
        .enumerate()
        .map(|(i, _)| HostInfo {
            host: u32::try_from(i).unwrap_or(0),
            reference: spec
                .board
                .as_ref()
                .map_or_else(String::new, |b| b.reference.clone()),
            profile: spec
                .board
                .as_ref()
                .map_or_else(String::new, |b| b.profile.clone()),
            pins: host_pins.clone(),
        })
        .collect();
    let hosts = std::mem::take(&mut cut.hosts);
    let mut kernel = Kernel::new(bus, cut.units, options.config).map_err(|e| e.to_string())?;
    for host in hosts {
        kernel
            .add_host(&host.name, host.domain, host.reads, host.writes)
            .map_err(|e| e.to_string())?;
    }
    if options.trace_all {
        let ids: Vec<_> = kernel.bus().ids().collect();
        for id in ids {
            kernel.bus_mut().trace(id, SimTime::ZERO);
        }
    }

    let bus = kernel.bus();
    let info = DeviceInfo {
        scope: scope.name.clone(),
        units: kernel
            .units()
            .into_iter()
            .map(|(name, domain, kind)| {
                (
                    name,
                    domain.as_str().to_owned(),
                    format!("{kind:?}").to_lowercase(),
                )
            })
            .collect(),
        hosts: host_infos,
        stubs: cut.stubs,
        left_out: cut.left_out,
        controls: kernel.controls(),
        io_panel,
        signals: bus
            .ids()
            .map(|id| (bus.name(id).to_owned(), bus.kind(id)))
            .collect(),
        bodies: spec
            .mechanics
            .iter()
            .map(|b| BodyInfo {
                name: b.name.clone(),
                object: b.object.clone(),
                axis: b.axis,
                origin: b.origin,
                angle: format!("body:{}.angle", b.name),
                omega: format!("{}.omega", b.driven_by),
            })
            .collect(),
        leds: spec
            .parts
            .iter()
            .filter(|p| p.model == "led")
            .map(|p| (p.reference.clone(), format!("{}.brightness", p.reference)))
            .collect(),
        mechanics_engine,
    };
    Ok(BuiltDevice { kernel, info })
}
