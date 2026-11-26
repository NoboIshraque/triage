//! The T0 circuit unit (ROADMAP P3-3, PLAN §4.7): the netlist is partitioned into
//! rails (ground, the board's regulator, supplies: held at fixed voltages), logic
//! nets (only digital pins: a board pin and an I²C display, resolved from the
//! driver's level) and analog islands, each solved on its own by the MNA solver.
//! Islands with inductors or capacitors take backward-Euler steps of at most
//! 10 µs; resistive islands are solved once per coupling step.

use std::collections::{BTreeMap, BTreeSet};

use triage_mna::{Circuit, Element, ElementId, GROUND, Node};
use triage_sim_kernel::{
    Domain, Logic, SignalBus, SignalId, SignalKind, SimTime, StepContext, Unit, UnitKind, Value,
};

use crate::spec::{DeviceSpec, PartSpec};

/// Output resistance of an AVR pin driven high or low, Ω.
const PIN_OHMS: f64 = 25.0;
/// The AVR's pull-up resistance, Ω.
const PULL_UP_OHMS: f64 = 35_000.0;
/// An undriven pin, Ω.
const OPEN_OHMS: f64 = 1e9;
/// Longest backward-Euler step for islands with inductors or capacitors, s.
const MAX_REACTIVE_STEP: f64 = 10e-6;

/// Union-find: the representative of `x`'s set.
fn find(parent: &mut BTreeMap<String, String>, x: &str) -> String {
    let p = parent.get(x).cloned().unwrap_or_else(|| x.to_owned());
    if p == x {
        parent.insert(x.to_owned(), p.clone());
        return p;
    }
    let root = find(parent, &p);
    parent.insert(x.to_owned(), root.clone());
    root
}

/// Model pins that are digital (bus lines, servo signals): their nets can be logic nets.
fn is_digital_pin(model: &str, pin: &str) -> bool {
    matches!(
        (model, pin),
        ("ssd1306", "scl" | "sda") | ("servo", "signal")
    )
}

/// Parts whose circuit side is only a load on their supply pins.
fn supply_load(part: &PartSpec) -> Option<(String, String, f64)> {
    let amps = match part.model.as_str() {
        "ssd1306" => part.param("supply_a", 0.02),
        "servo" => part.param("supply_a", 0.01),
        _ => return None,
    };
    Some((
        part.net("vcc")?.to_owned(),
        part.net("gnd")?.to_owned(),
        amps,
    ))
}

/// Nets held at a fixed voltage: ground, the regulator's output, supplies.
fn rails(spec: &DeviceSpec) -> BTreeMap<String, f64> {
    let mut rails = BTreeMap::new();
    rails.insert(spec.ground.clone(), 0.0);
    if let Some(regulator) = spec.board.as_ref().and_then(|b| b.regulator.as_ref()) {
        rails.insert(regulator.net.clone(), regulator.volts);
    }
    for part in spec.parts.iter().filter(|p| p.model == "supply") {
        if let Some(net) = part.net("+") {
            rails.insert(net.to_owned(), part.param("volts", 12.0));
        }
    }
    rails
}

/// The signal name of a net's voltage.
#[must_use]
pub fn net_signal(net: &str) -> String {
    format!("net:{net}")
}

/// The signal name of a board pin's drive.
#[must_use]
pub fn drive_signal(board: &str, pin: &str) -> String {
    format!("{board}.{pin}.drive")
}

enum PartState {
    Ntc {
        element: ElementId,
        r25: f64,
        beta: f64,
    },
    Button {
        element: ElementId,
        pressed: bool,
    },
    Pot {
        upper: ElementId,
        lower: ElementId,
        ohms: f64,
        position: f64,
    },
    Led {
        element: ElementId,
        rated: f64,
        brightness: SignalId,
    },
    Motor {
        coil: ElementId,
        emf: ElementId,
        ke: f64,
        kt: f64,
        omega: SignalId,
        torque: SignalId,
        current: SignalId,
    },
    Passive {
        element: ElementId,
    },
}

struct IslandPart {
    reference: String,
    state: PartState,
}

struct PinSource {
    drive: SignalId,
    ohms: ElementId,
    volts: ElementId,
    vcc: f64,
}

struct Island {
    circuit: Circuit,
    reactive: bool,
    nets: Vec<(SignalId, Node)>,
    pins: Vec<PinSource>,
    parts: Vec<IslandPart>,
    rails: Vec<(usize, ElementId)>,
    failures: u64,
}

struct LogicNet {
    signal: SignalId,
    drivers: Vec<(SignalId, f64)>,
}

struct Rail {
    current: SignalId,
    /// Constant draws on it (displays, the board itself), A.
    fixed: f64,
    /// Rails whose current comes out of this one (the regulator from VIN).
    feeds: Vec<usize>,
}

/// The circuit unit.
pub struct CircuitUnit {
    islands: Vec<Island>,
    logic: Vec<LogicNet>,
    rails: Vec<Rail>,
    temperature: Option<SignalId>,
    controls: BTreeMap<String, (usize, usize)>,
    reads: Vec<SignalId>,
    writes: Vec<SignalId>,
}

impl CircuitUnit {
    /// Builds the circuit of a device and solves its operating point, so the bus
    /// starts with the circuit's voltages.
    ///
    /// # Errors
    /// For a part with a missing pin or parameter, or an operating point that fails.
    #[allow(clippy::too_many_lines)]
    pub fn new(spec: &DeviceSpec, bus: &mut SignalBus) -> Result<CircuitUnit, String> {
        let rail_volts = rails(spec);
        let analog_parts: Vec<&PartSpec> = spec
            .parts
            .iter()
            .filter(|p| !matches!(p.model.as_str(), "none" | "supply" | "ssd1306" | "servo"))
            .collect();

        // Union-find over non-rail nets joined by analog parts.
        let mut parent: BTreeMap<String, String> = BTreeMap::new();
        for part in &analog_parts {
            let nets: Vec<&str> = part
                .pins
                .values()
                .map(String::as_str)
                .filter(|n| !rail_volts.contains_key(*n) && !n.is_empty())
                .collect();
            for net in &nets {
                find(&mut parent, net);
            }
            for pair in nets.windows(2) {
                let (a, b) = (find(&mut parent, pair[0]), find(&mut parent, pair[1]));
                if a != b {
                    parent.insert(a, b);
                }
            }
        }
        let analog_nets: BTreeSet<String> = parent.keys().cloned().collect();
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for net in &analog_nets {
            let root = find(&mut parent, net);
            groups.entry(root).or_default().push(net.clone());
        }

        // Rails and their current signals.
        let rail_names: Vec<String> = rail_volts
            .keys()
            .filter(|n| **n != spec.ground)
            .cloned()
            .collect();
        let mut rails: Vec<Rail> = rail_names
            .iter()
            .map(|net| Rail {
                current: bus.declare(
                    &format!("rail:{net}.current"),
                    SignalKind::Real,
                    Value::Real(0.0),
                ),
                fixed: 0.0,
                feeds: Vec::new(),
            })
            .collect();
        let rail_index = |net: &str| rail_names.iter().position(|n| n == net);
        for part in &spec.parts {
            if let Some((vcc, _, amps)) = supply_load(part)
                && let Some(i) = rail_index(&vcc)
            {
                rails[i].fixed += amps;
            }
        }
        if let Some(board) = &spec.board
            && let Some(vin) = board.vin.as_deref().and_then(rail_index)
        {
            rails[vin].fixed += board.quiescent_a.unwrap_or(0.045);
            if let Some(reg) = board.regulator.as_ref().and_then(|r| rail_index(&r.net)) {
                rails[vin].feeds.push(reg);
            }
        }

        let temperature = analog_parts.iter().any(|p| p.model == "ntc").then(|| {
            bus.declare(
                "env:temperature_c",
                SignalKind::Real,
                Value::Real(spec.environment.room_temperature_c),
            )
        });

        let mut unit = CircuitUnit {
            islands: Vec::new(),
            logic: Vec::new(),
            rails,
            temperature,
            controls: BTreeMap::new(),
            reads: temperature.into_iter().collect(),
            writes: Vec::new(),
        };
        unit.writes.extend(unit.rails.iter().map(|r| r.current));

        for nets in groups.values() {
            let mut island = Island {
                circuit: Circuit::new(),
                reactive: false,
                nets: Vec::new(),
                pins: Vec::new(),
                parts: Vec::new(),
                rails: Vec::new(),
                failures: 0,
            };
            let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
            for net in nets {
                let node = island.circuit.node();
                nodes.insert(net.clone(), node);
                let signal = bus.declare(&net_signal(net), SignalKind::Real, Value::Real(0.0));
                island.nets.push((signal, node));
                unit.writes.push(signal);
            }
            // Rails this island touches become sources.
            let members: Vec<&&PartSpec> = analog_parts
                .iter()
                .filter(|p| p.pins.values().any(|n| nodes.contains_key(n)))
                .collect();
            for part in &members {
                for net in part.pins.values() {
                    if nodes.contains_key(net) || net.is_empty() {
                        continue;
                    }
                    if *net == spec.ground {
                        nodes.insert(net.clone(), GROUND);
                    } else if let Some(&volts) = rail_volts.get(net) {
                        let node = island.circuit.node();
                        let source = island.circuit.add(Element::VoltageSource {
                            p: node,
                            n: GROUND,
                            volts,
                        });
                        nodes.insert(net.clone(), node);
                        if let Some(i) = rail_index(net) {
                            island.rails.push((i, source));
                        }
                    }
                }
            }
            let at = |pin: &str, part: &PartSpec| -> Result<Node, String> {
                let net = part
                    .net(pin)
                    .ok_or_else(|| format!("{} has no net on pin \"{pin}\"", part.reference))?;
                nodes
                    .get(net)
                    .copied()
                    .ok_or_else(|| format!("{}: net {net} isn't in the circuit", part.reference))
            };
            for part in members {
                let state = add_part(&mut island.circuit, part, &at, bus, &mut unit, spec)?;
                if let Some(state) = state {
                    let index = island.parts.len();
                    let island_index = unit.islands.len();
                    match &state {
                        PartState::Button { .. } => {
                            unit.controls.insert(
                                format!("{}.pressed", part.reference),
                                (island_index, index),
                            );
                        }
                        PartState::Pot { .. } => {
                            unit.controls.insert(
                                format!("{}.position", part.reference),
                                (island_index, index),
                            );
                        }
                        PartState::Motor { .. } => island.reactive = true,
                        _ => {}
                    }
                    if matches!(part.model.as_str(), "capacitor" | "inductor") {
                        island.reactive = true;
                    }
                    island.parts.push(IslandPart {
                        reference: part.reference.clone(),
                        state,
                    });
                }
            }
            // Board pins on this island's nets: a Thevenin source per pin.
            if let Some(board) = &spec.board {
                for pin in board.pins.iter().filter(|p| nodes.contains_key(&p.net)) {
                    let node = nodes[&pin.net];
                    let inner = island.circuit.node();
                    let ohms = island.circuit.add(Element::Resistor {
                        a: node,
                        b: inner,
                        ohms: OPEN_OHMS,
                    });
                    let volts = island.circuit.add(Element::VoltageSource {
                        p: inner,
                        n: GROUND,
                        volts: 0.0,
                    });
                    let drive = bus.declare(
                        &drive_signal(&board.reference, &pin.name),
                        SignalKind::Logic,
                        Value::Logic(Logic::Z),
                    );
                    let vcc = board.regulator.as_ref().map_or(5.0, |r| r.volts);
                    island.pins.push(PinSource {
                        drive,
                        ohms,
                        volts,
                        vcc,
                    });
                    unit.reads.push(drive);
                }
            }
            unit.islands.push(island);
        }

        // Logic nets: nets with board pins and digital part pins only.
        if let Some(board) = &spec.board {
            let digital: BTreeSet<&str> = spec
                .parts
                .iter()
                .flat_map(|p| {
                    p.pins
                        .iter()
                        .filter(|(pin, _)| is_digital_pin(&p.model, pin))
                        .map(|(_, n)| n.as_str())
                })
                .collect();
            let vcc = board.regulator.as_ref().map_or(5.0, |r| r.volts);
            let mut by_net: BTreeMap<&str, Vec<SignalId>> = BTreeMap::new();
            for pin in &board.pins {
                if analog_nets.contains(&pin.net)
                    || rail_volts.contains_key(&pin.net)
                    || !digital.contains(pin.net.as_str())
                {
                    continue;
                }
                let drive = bus.declare(
                    &drive_signal(&board.reference, &pin.name),
                    SignalKind::Logic,
                    Value::Logic(Logic::Z),
                );
                by_net.entry(pin.net.as_str()).or_default().push(drive);
            }
            for (net, drivers) in by_net {
                let signal = bus.declare(&net_signal(net), SignalKind::Real, Value::Real(0.0));
                unit.reads.extend(&drivers);
                unit.writes.push(signal);
                unit.logic.push(LogicNet {
                    signal,
                    drivers: drivers.into_iter().map(|d| (d, vcc)).collect(),
                });
            }
        }

        unit.reads.sort_unstable();
        unit.reads.dedup();
        unit.operating_point(bus)?;
        Ok(unit)
    }

    /// Solves every island's operating point with the bus's inputs and writes it.
    fn operating_point(&mut self, bus: &mut SignalBus) -> Result<(), String> {
        let temperature = self.temperature.map(|t| bus.real(t));
        for island in &mut self.islands {
            island.update_inputs(bus, temperature);
            island
                .circuit
                .solve_dc()
                .map_err(|e| format!("the circuit's operating point: {e}"))?;
        }
        self.write_outputs(bus, SimTime::ZERO);
        Ok(())
    }

    fn write_outputs(&self, bus: &mut SignalBus, t: SimTime) {
        let mut rail_currents = vec![0.0; self.rails.len()];
        for island in &self.islands {
            for &(signal, node) in &island.nets {
                bus.set(signal, t, Value::Real(island.circuit.voltage(node)));
            }
            for part in &island.parts {
                match part.state {
                    PartState::Led {
                        element,
                        rated,
                        brightness,
                    } => {
                        let i = island.circuit.current(element).max(0.0);
                        bus.set(brightness, t, Value::Real((i / rated).min(1.5)));
                    }
                    PartState::Motor {
                        coil,
                        kt,
                        torque,
                        current,
                        ..
                    } => {
                        let i = island.circuit.current(coil);
                        bus.set(current, t, Value::Real(i));
                        bus.set(torque, t, Value::Real(kt * i));
                    }
                    _ => {}
                }
            }
            for &(rail, source) in &island.rails {
                rail_currents[rail] += island.circuit.current(source);
            }
        }
        for (i, rail) in self.rails.iter().enumerate() {
            rail_currents[i] += rail.fixed;
        }
        let fed: Vec<(usize, f64)> = self
            .rails
            .iter()
            .enumerate()
            .flat_map(|(i, r)| r.feeds.iter().map(move |&f| (i, f)))
            .map(|(i, f)| (i, rail_currents[f]))
            .collect();
        for (i, amps) in fed {
            rail_currents[i] += amps;
        }
        for (rail, amps) in self.rails.iter().zip(rail_currents) {
            bus.set(rail.current, t, Value::Real(amps));
        }
        for net in &self.logic {
            let level = net
                .drivers
                .iter()
                .map(|&(d, vcc)| match bus.logic(d) {
                    Logic::High | Logic::WeakHigh => Some(vcc),
                    Logic::Low | Logic::WeakLow => Some(0.0),
                    Logic::Z => None,
                })
                .find_map(|v| v)
                // An I²C line is pulled up on the display's module.
                .unwrap_or(net.drivers.first().map_or(0.0, |d| d.1));
            bus.set(net.signal, t, Value::Real(level));
        }
    }
}

#[allow(clippy::too_many_lines)]
fn add_part(
    circuit: &mut Circuit,
    part: &PartSpec,
    at: &dyn Fn(&str, &PartSpec) -> Result<Node, String>,
    bus: &mut SignalBus,
    unit: &mut CircuitUnit,
    spec: &DeviceSpec,
) -> Result<Option<PartState>, String> {
    let r = &part.reference;
    Ok(Some(match part.model.as_str() {
        "resistor" => {
            let ohms = part
                .params
                .get("ohms")
                .copied()
                .ok_or_else(|| format!("{r}: a resistor needs \"ohms\""))?;
            PartState::Passive {
                element: circuit.add(Element::Resistor {
                    a: at("a", part)?,
                    b: at("b", part)?,
                    ohms,
                }),
            }
        }
        "ntc" => {
            let r25 = part.param("r25", 10_000.0);
            let element = circuit.add(Element::Resistor {
                a: at("a", part)?,
                b: at("b", part)?,
                ohms: r25,
            });
            PartState::Ntc {
                element,
                r25,
                beta: part.param("beta", 3950.0),
            }
        }
        "pot" => {
            let ohms = part.param("ohms", 10_000.0);
            let position = part.param("position", 0.5).clamp(0.0, 1.0);
            let wiper = at("wiper", part)?;
            let upper = circuit.add(Element::Resistor {
                a: at("a", part)?,
                b: wiper,
                ohms: (ohms * (1.0 - position)).max(1e-3),
            });
            let lower = circuit.add(Element::Resistor {
                a: wiper,
                b: at("b", part)?,
                ohms: (ohms * position).max(1e-3),
            });
            PartState::Pot {
                upper,
                lower,
                ohms,
                position,
            }
        }
        "button" => {
            let element = circuit.add(Element::Switch {
                a: at("a", part)?,
                b: at("b", part)?,
                closed: false,
                on_ohms: part.param("on_ohms", 0.05),
                off_ohms: part.param("off_ohms", 1e9),
            });
            PartState::Button {
                element,
                pressed: false,
            }
        }
        "led" | "diode" => {
            let led = part.model == "led";
            let element = circuit.add(Element::Diode {
                anode: at("anode", part)?,
                cathode: at("cathode", part)?,
                is: part.param("is", if led { 1e-18 } else { 7e-9 }),
                n: part.param("n", if led { 2.0 } else { 1.8 }),
                rs: part.param("rs", if led { 5.0 } else { 0.034 }),
            });
            if led {
                let brightness = bus.declare(
                    &format!("{r}.brightness"),
                    SignalKind::Real,
                    Value::Real(0.0),
                );
                unit.writes.push(brightness);
                PartState::Led {
                    element,
                    rated: part.param("rated_a", 0.02),
                    brightness,
                }
            } else {
                PartState::Passive { element }
            }
        }
        "nmos" => PartState::Passive {
            element: circuit.add(Element::Nmos {
                d: at("d", part)?,
                g: at("g", part)?,
                s: at("s", part)?,
                vth: part.param("vth", 1.5),
                k: part.param("k", 13.0),
                lambda: part.param("lambda", 0.01),
            }),
        },
        "capacitor" => PartState::Passive {
            element: circuit.add(Element::Capacitor {
                a: at("a", part)?,
                b: at("b", part)?,
                farads: part
                    .params
                    .get("farads")
                    .copied()
                    .ok_or_else(|| format!("{r}: a capacitor needs \"farads\""))?,
            }),
        },
        "inductor" => PartState::Passive {
            element: circuit.add(Element::Inductor {
                a: at("a", part)?,
                b: at("b", part)?,
                henries: part
                    .params
                    .get("henries")
                    .copied()
                    .ok_or_else(|| format!("{r}: an inductor needs \"henries\""))?,
            }),
        },
        "dc-motor" => {
            let plus = at("+", part)?;
            let minus = at("-", part)?;
            let m1 = circuit.node();
            let m2 = circuit.node();
            circuit.add(Element::Resistor {
                a: plus,
                b: m1,
                ohms: part.param("ohms", 20.0),
            });
            let coil = circuit.add(Element::Inductor {
                a: m1,
                b: m2,
                henries: part.param("henries", 2e-3),
            });
            let emf = circuit.add(Element::VoltageSource {
                p: m2,
                n: minus,
                volts: 0.0,
            });
            let omega = bus.declare(&format!("{r}.omega"), SignalKind::Real, Value::Real(0.0));
            let torque = bus.declare(&format!("{r}.torque"), SignalKind::Real, Value::Real(0.0));
            let current = bus.declare(&format!("{r}.current"), SignalKind::Real, Value::Real(0.0));
            unit.reads.push(omega);
            unit.writes.extend([torque, current]);
            let _ = spec;
            PartState::Motor {
                coil,
                emf,
                ke: part.param("ke", 0.025),
                kt: part.param("kt", 0.025),
                omega,
                torque,
                current,
            }
        }
        other => return Err(format!("{r}: no circuit model \"{other}\"")),
    }))
}

impl Island {
    fn update_inputs(&mut self, bus: &SignalBus, temperature: Option<f64>) {
        for pin in &self.pins {
            let (ohms, volts) = match bus.logic(pin.drive) {
                Logic::High => (PIN_OHMS, pin.vcc),
                Logic::Low => (PIN_OHMS, 0.0),
                Logic::WeakHigh => (PULL_UP_OHMS, pin.vcc),
                Logic::WeakLow => (PULL_UP_OHMS, 0.0),
                Logic::Z => (OPEN_OHMS, 0.0),
            };
            self.circuit.set_ohms(pin.ohms, ohms);
            self.circuit.set_volts(pin.volts, volts);
        }
        for part in &self.parts {
            match part.state {
                PartState::Ntc { element, r25, beta } => {
                    let kelvin = temperature.unwrap_or(25.0) + 273.15;
                    let ohms = r25 * (beta * (1.0 / kelvin - 1.0 / 298.15)).exp();
                    self.circuit.set_ohms(element, ohms);
                }
                PartState::Motor { emf, ke, omega, .. } => {
                    self.circuit.set_volts(emf, ke * bus.real(omega));
                }
                PartState::Button { element, pressed } => self.circuit.set_closed(element, pressed),
                PartState::Pot {
                    upper,
                    lower,
                    ohms,
                    position,
                } => {
                    self.circuit
                        .set_ohms(upper, (ohms * (1.0 - position)).max(1e-3));
                    self.circuit.set_ohms(lower, (ohms * position).max(1e-3));
                }
                _ => {}
            }
        }
    }

    fn advance(&mut self, seconds: f64) {
        if self.reactive && seconds > 0.0 {
            let mut steps = 1u32;
            while f64::from(steps) * MAX_REACTIVE_STEP < seconds {
                steps += 1;
            }
            let h = seconds / f64::from(steps);
            for _ in 0..steps {
                if self.circuit.step(h).is_err() {
                    self.failures += 1;
                    return;
                }
            }
        } else if self.circuit.solve_dc().is_err() {
            self.failures += 1;
        }
    }
}

impl Unit for CircuitUnit {
    fn name(&self) -> &'static str {
        "circuit"
    }
    fn domain(&self) -> Domain {
        Domain::Circuit
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        self.reads.clone()
    }
    fn writes(&self) -> Vec<SignalId> {
        self.writes.clone()
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        let seconds = (ctx.until - ctx.now).seconds();
        let temperature = self.temperature.map(|t| ctx.bus.real(t));
        for island in &mut self.islands {
            island.update_inputs(ctx.bus, temperature);
            island.advance(seconds);
        }
        self.write_outputs(ctx.bus, ctx.until);
        ctx.until
    }
    fn controls(&self) -> Vec<String> {
        self.controls.keys().cloned().collect()
    }
    fn control(&mut self, name: &str, value: f64) -> bool {
        let Some(&(island, part)) = self.controls.get(name) else {
            return false;
        };
        match &mut self.islands[island].parts[part].state {
            PartState::Button { pressed, .. } => *pressed = value > 0.5,
            PartState::Pot { position, .. } => *position = value.clamp(0.0, 1.0),
            _ => return false,
        }
        true
    }
    fn readouts(&self) -> Vec<(String, f64)> {
        let mut out = Vec::new();
        for island in &self.islands {
            for part in &island.parts {
                let current = match part.state {
                    PartState::Ntc { element, .. }
                    | PartState::Button { element, .. }
                    | PartState::Led { element, .. }
                    | PartState::Passive { element } => island.circuit.current(element),
                    PartState::Motor { coil, .. } => island.circuit.current(coil),
                    PartState::Pot { lower, .. } => island.circuit.current(lower),
                };
                out.push((format!("{}.current", part.reference), current));
            }
            if island.failures > 0 {
                #[allow(clippy::cast_precision_loss)]
                out.push(("failures".into(), island.failures as f64));
            }
        }
        out
    }
}
