//! P3-1 done-when: deterministic replay; scheduler property tests; each stub kind
//! behaves as declared (ROADMAP P3-1).

#![allow(clippy::unwrap_used, clippy::unnecessary_literal_bound)]

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use proptest::prelude::*;
use triage_sim_kernel::{
    Change, Domain, Generator, HostReport, HostSpec, IdealModel, Kernel, KernelConfig, Logic, Rng,
    Scope, SignalBus, SignalId, SignalKind, SimDuration, SimTime, StepContext, StubSpec, Unit,
    UnitKind, Value, cut,
};

const MS: i64 = 1_000_000_000;
const US: i64 = 1_000_000;

/// A firmware-like producer: toggles `out` every `half_period`, faster while `button`
/// reads high, with seeded jitter; stops at each edge (early return).
struct Blinker {
    out: SignalId,
    button: SignalId,
    next_edge: SimTime,
    level: bool,
    rng: Rng,
}

impl Unit for Blinker {
    fn name(&self) -> &str {
        "blinker"
    }
    fn domain(&self) -> Domain {
        Domain::Firmware
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Producer
    }
    fn reads(&self) -> Vec<SignalId> {
        vec![self.button]
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.out]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        if self.next_edge >= ctx.until {
            return ctx.until;
        }
        let t = self.next_edge.max(ctx.now);
        self.level = !self.level;
        let level = if self.level { Logic::High } else { Logic::Low };
        ctx.emit(t, self.out, Value::Logic(level));
        let fast = ctx.bus.logic(self.button).is_high();
        let base = if fast { 300 * US } else { 1_100 * US };
        let jitter = i64::try_from(self.rng.next_u64() % 50).unwrap() * US;
        self.next_edge = t + SimDuration(base + jitter);
        t
    }
}

/// Continuous: an RC low-pass of the pin (0/5 V), exact for held inputs.
struct Rc1 {
    pin: SignalId,
    out: SignalId,
    v: f64,
    tau: f64,
}

impl Unit for Rc1 {
    fn name(&self) -> &str {
        "rc"
    }
    fn domain(&self) -> Domain {
        Domain::Circuit
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        vec![self.pin]
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.out]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        let vin = if ctx.bus.logic(self.pin).is_high() {
            5.0
        } else {
            0.0
        };
        let dt = (ctx.until - ctx.now).seconds();
        self.v = vin + (self.v - vin) * (-dt / self.tau).exp();
        ctx.set(self.out, Value::Real(self.v));
        ctx.until
    }
}

/// A button the UI presses: a continuous unit with a control.
struct Button {
    out: SignalId,
    pressed: bool,
}

impl Unit for Button {
    fn name(&self) -> &str {
        "SW1"
    }
    fn domain(&self) -> Domain {
        Domain::Parts
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Continuous
    }
    fn reads(&self) -> Vec<SignalId> {
        Vec::new()
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.out]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        let level = if self.pressed {
            Logic::High
        } else {
            Logic::Low
        };
        ctx.set_from_start(self.out, Value::Logic(level));
        ctx.until
    }
    fn controls(&self) -> Vec<String> {
        vec!["SW1.pressed".into()]
    }
    fn control(&mut self, _name: &str, value: f64) -> bool {
        self.pressed = value > 0.5;
        true
    }
}

/// Records every interval it is stepped over, and the inputs it saw.
struct Probe {
    reads: Vec<SignalId>,
    log: Rc<RefCell<Vec<(SimTime, SimTime)>>>,
    integral: Rc<RefCell<f64>>,
}

impl Unit for Probe {
    fn name(&self) -> &str {
        "probe"
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
        Vec::new()
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        self.log.borrow_mut().push((ctx.now, ctx.until));
        if let Some(&first) = self.reads.first() {
            *self.integral.borrow_mut() += ctx.bus.real(first) * (ctx.until - ctx.now).seconds();
        }
        ctx.until
    }
}

fn blink_device(seed: u64) -> (SignalBus, Vec<Box<dyn Unit>>) {
    let mut bus = SignalBus::new();
    let out = bus.declare("pin", SignalKind::Logic, Value::Logic(Logic::Low));
    let button = bus.declare("button", SignalKind::Logic, Value::Logic(Logic::Low));
    let v = bus.declare("v", SignalKind::Real, Value::Real(0.0));
    for id in [out, button, v] {
        bus.trace(id, SimTime::ZERO);
    }
    let units: Vec<Box<dyn Unit>> = vec![
        Box::new(Blinker {
            out,
            button,
            next_edge: SimTime::ZERO,
            level: false,
            rng: Rng::new(seed),
        }),
        Box::new(Rc1 {
            pin: out,
            out: v,
            v: 0.0,
            tau: 0.002,
        }),
        Box::new(Button {
            out: button,
            pressed: false,
        }),
    ];
    (bus, units)
}

#[test]
fn replay_reproduces_a_run_exactly() {
    let (bus, units) = blink_device(7);
    let mut first = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    // UI presses arrive "asynchronously": queued at the kernel's time when they come.
    for (at, value) in [(40, 1.0), (95, 0.0), (130, 1.0), (170, 0.0)] {
        first.run_until(SimTime(at * MS)).unwrap();
        first.input(first.now(), "SW1.pressed", value).unwrap();
    }
    first.run_until(SimTime(250 * MS)).unwrap();
    let recording = first.recording().to_vec();
    assert_eq!(recording.len(), 4);

    let (bus, units) = blink_device(7);
    let mut replay = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    for input in &recording {
        replay.input(input.t, &input.control, input.value).unwrap();
    }
    replay.run_until(SimTime(250 * MS)).unwrap();
    assert_eq!(first.bus().trace_hash(), replay.bus().trace_hash());
    assert_eq!(first.stats(), replay.stats());

    // A different seed is a different history.
    let (bus, units) = blink_device(8);
    let mut other = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    for input in &recording {
        other.input(input.t, &input.control, input.value).unwrap();
    }
    other.run_until(SimTime(250 * MS)).unwrap();
    assert_ne!(first.bus().trace_hash(), other.bus().trace_hash());
}

/// The same device with the blinker as a host (as the JS AVR unit is): the caller
/// runs it between grant and complete. Same history as the in-kernel producer.
#[test]
fn a_host_producer_matches_an_in_kernel_one() {
    let (bus, units) = blink_device(3);
    let mut inside = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    inside.input(SimTime(20 * MS), "SW1.pressed", 1.0).unwrap();
    inside.run_until(SimTime(100 * MS)).unwrap();

    let (bus, mut units) = blink_device(3);
    let mut blinker = units.remove(0);
    let (pin, button) = (bus.id("pin").unwrap(), bus.id("button").unwrap());
    let mut host = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    let id = host
        .add_host("blinker", Domain::Firmware, vec![button], vec![pin])
        .unwrap();
    host.input(SimTime(20 * MS), "SW1.pressed", 1.0).unwrap();
    // The host keeps its own copy of the inputs it was told about.
    let mut view = SignalBus::new();
    view.declare("pin", SignalKind::Logic, Value::Logic(Logic::Low));
    view.declare("button", SignalKind::Logic, Value::Logic(Logic::Low));
    let mut local = SimTime::ZERO;
    while host.now() < SimTime(100 * MS) {
        let grant = host.grant().unwrap();
        let until = grant.until.min(SimTime(100 * MS));
        let mut events = Vec::new();
        let mut ctx = StepContext::host(&mut view, local, until, &mut events);
        let reached = blinker.step(&mut ctx);
        local = reached;
        let report = HostReport {
            host: id.0,
            reached,
            events: events.iter().map(|e| (e.t, e.signal, e.value)).collect(),
        };
        let unblock = host.complete(vec![report]).unwrap();
        for (signal, value) in &unblock.hosts[0].changed {
            view.set(*signal, unblock.now, *value);
        }
    }
    assert_eq!(inside.bus().changes(pin), host.bus().changes(pin));
    assert_eq!(inside.bus().changes(button), host.bus().changes(button));
}

#[test]
fn inputs_need_a_control_someone_has() {
    let (bus, units) = blink_device(1);
    let mut kernel = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    assert!(kernel.input(SimTime::ZERO, "nobody.knob", 1.0).is_err());
    assert_eq!(kernel.controls(), vec!["SW1.pressed".to_owned()]);
}

#[test]
fn two_writers_are_refused() {
    let mut bus = SignalBus::new();
    let s = bus.declare("s", SignalKind::Logic, Value::Logic(Logic::Low));
    let units: Vec<Box<dyn Unit>> = vec![
        Box::new(Button {
            out: s,
            pressed: false,
        }),
        Box::new(Button {
            out: s,
            pressed: true,
        }),
    ];
    assert!(Kernel::new(bus, units, KernelConfig::default()).is_err());
}

// ---- scheduler properties ------------------------------------------------------------

/// A producer that emits a given list of (time, level) edges, stopping at each.
struct Script {
    out: SignalId,
    edges: Vec<(SimTime, bool)>,
    next: usize,
    early_return: bool,
}

impl Unit for Script {
    fn name(&self) -> &str {
        "script"
    }
    fn domain(&self) -> Domain {
        Domain::Firmware
    }
    fn kind(&self) -> UnitKind {
        UnitKind::Producer
    }
    fn reads(&self) -> Vec<SignalId> {
        Vec::new()
    }
    fn writes(&self) -> Vec<SignalId> {
        vec![self.out]
    }
    fn step(&mut self, ctx: &mut StepContext<'_>) -> SimTime {
        while let Some(&(t, high)) = self.edges.get(self.next) {
            if t >= ctx.until {
                break;
            }
            let level = if high { Logic::High } else { Logic::Low };
            ctx.emit(t.max(ctx.now), self.out, Value::Logic(level));
            self.next += 1;
            if self.early_return {
                return t.max(ctx.now);
            }
        }
        ctx.until
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Whatever the quantum, coupling step and edge times: time only moves forward,
    /// continuous units step over contiguous intervals, every edge lands exactly once
    /// at its time, and an exact integrator gets the exact integral.
    #[test]
    fn scheduler_invariants(
        gaps in proptest::collection::vec(1i64..3_000, 1..60),
        quantum_us in 1i64..2_000,
        coupling_us in 1i64..500,
        early_return in any::<bool>(),
    ) {
        let mut t = 0;
        let mut edges = Vec::new();
        for (i, gap) in gaps.iter().enumerate() {
            t += gap * US;
            edges.push((SimTime(t), i % 2 == 0));
        }
        let end = SimTime(t + 5 * MS);

        let mut bus = SignalBus::new();
        let out = bus.declare("out", SignalKind::Logic, Value::Logic(Logic::Low));
        bus.trace(out, SimTime::ZERO);
        let log = Rc::new(RefCell::new(Vec::new()));
        let integral = Rc::new(RefCell::new(0.0));
        let units: Vec<Box<dyn Unit>> = vec![
            Box::new(Script { out, edges: edges.clone(), next: 0, early_return }),
            Box::new(Probe { reads: vec![out], log: log.clone(), integral: integral.clone() }),
        ];
        let config = KernelConfig {
            quantum_max: SimDuration(quantum_us * US),
            quantum_min: SimDuration(US.min(quantum_us * US)),
            coupling_step: SimDuration(coupling_us * US),
        };
        let mut kernel = Kernel::new(bus, units, config).unwrap();
        let mut last = SimTime::ZERO;
        while kernel.now() < end {
            kernel.run_until((kernel.now() + SimDuration(quantum_us * US)).min(end)).unwrap();
            prop_assert!(kernel.now() >= last);
            prop_assert!(kernel.quantum() >= config.quantum_min && kernel.quantum() <= config.quantum_max);
            last = kernel.now();
        }
        prop_assert_eq!(kernel.now(), end);

        // Contiguous, non-overlapping intervals from 0 to the end, each ≤ the coupling step.
        let log = log.borrow();
        let mut at = SimTime::ZERO;
        for &(from, to) in log.iter() {
            prop_assert_eq!(from, at);
            prop_assert!(to > from && to - from <= config.coupling_step);
            at = to;
        }
        prop_assert_eq!(at, end);

        // Every edge exactly once, at its time.
        let changes: Vec<(SimTime, bool)> =
            kernel.bus().changes(out)[1..].iter().map(|c| (c.t, c.value.as_logic().is_high())).collect();
        prop_assert_eq!(changes, edges.clone());

        // The probe integrates the held level exactly: the time spent high.
        let mut high_time = 0.0;
        for pair in edges.chunks(2) {
            let rise = pair[0].0;
            let fall = pair.get(1).map_or(end, |e| e.0);
            high_time += (fall - rise).seconds();
        }
        prop_assert!((*integral.borrow() - high_time).abs() < 1e-9);
    }
}

// ---- stubs ------------------------------------------------------------------------------

fn stub_kernel(spec: &StubSpec, kind: SignalKind, initial: Value) -> (Kernel, SignalId) {
    let mut bus = SignalBus::new();
    let signal = bus.declare("x", kind, initial);
    let torque = bus.declare("torque", SignalKind::Real, Value::Real(0.002));
    bus.trace(signal, SimTime::ZERO);
    let log = Rc::new(RefCell::new(Vec::new()));
    let reader: Box<dyn Unit> = Box::new(Probe {
        reads: vec![signal, torque],
        log,
        integral: Rc::new(RefCell::new(0.0)),
    });
    let mut scope = Scope::only("probe only", &[Domain::Circuit]);
    scope.stubs.insert("x".into(), spec.clone());
    let cut = cut(&mut bus, vec![reader], Vec::new(), &scope, &BTreeMap::new()).unwrap();
    assert_eq!(cut.stubs.len(), 2, "x and torque are stubbed");
    let kernel = Kernel::new(bus, cut.units, KernelConfig::default()).unwrap();
    (kernel, signal)
}

#[test]
fn hold_stub_holds() {
    let (mut k, x) = stub_kernel(
        &StubSpec::Hold {
            value: Value::Real(3.3),
        },
        SignalKind::Real,
        Value::Real(0.0),
    );
    k.run_until(SimTime(50 * MS)).unwrap();
    assert_eq!(k.bus().get(x), Value::Real(3.3));
    assert_eq!(k.bus().changes(x).len(), 2, "one change, at the start");
}

#[test]
fn open_stub_is_disconnected() {
    let (mut k, x) = stub_kernel(
        &StubSpec::Open,
        SignalKind::Logic,
        Value::Logic(Logic::High),
    );
    k.run_until(SimTime(MS)).unwrap();
    assert_eq!(k.bus().get(x), Value::Logic(Logic::Z));
    let (mut k, x) = stub_kernel(&StubSpec::Open, SignalKind::Real, Value::Real(5.0));
    k.run_until(SimTime(MS)).unwrap();
    assert_eq!(k.bus().get(x), Value::Real(0.0));
}

#[test]
fn control_stub_follows_its_controls() {
    let spec = StubSpec::Control {
        value: Value::Real(1.0),
        generator: None,
    };
    let (mut k, x) = stub_kernel(&spec, SignalKind::Real, Value::Real(0.0));
    assert!(k.controls().contains(&"x.value".to_owned()));
    k.input(SimTime(10 * MS), "x.value", 2.5).unwrap();
    k.run_until(SimTime(20 * MS)).unwrap();
    let changes = k.bus().changes(x);
    assert_eq!(
        changes.last().unwrap(),
        &Change {
            t: SimTime(10 * MS),
            value: Value::Real(2.5)
        }
    );
}

#[test]
fn control_stub_generates_exact_pwm() {
    let spec = StubSpec::Control {
        value: Value::Logic(Logic::Low),
        generator: Some(Generator::Pwm {
            duty: 0.25,
            freq_hz: 500.0,
        }),
    };
    let (mut k, x) = stub_kernel(&spec, SignalKind::Logic, Value::Logic(Logic::Low));
    k.run_until(SimTime(10 * MS)).unwrap();
    // 500 Hz: rising every 2 ms, falling 0.5 ms later.
    let edges: Vec<(i64, bool)> = k.bus().changes(x)[1..]
        .iter()
        .map(|c| (c.t.0 / US, c.value.as_logic().is_high()))
        .collect();
    let expected: Vec<(i64, bool)> = (0..5)
        .flat_map(|i| [(i * 2000, true), (i * 2000 + 500, false)])
        .collect();
    assert_eq!(edges, expected);
    // Changing the duty takes effect at the next boundary.
    k.input(k.now(), "x.duty", 0.5).unwrap();
    k.run_until(SimTime(14 * MS)).unwrap();
    let late: Vec<(i64, bool)> = k
        .bus()
        .changes(x)
        .iter()
        .filter(|c| c.t.0 >= 10 * MS)
        .map(|c| (c.t.0 / US, c.value.as_logic().is_high()))
        .collect();
    assert_eq!(
        late,
        vec![
            (10_000, true),
            (11_000, false),
            (12_000, true),
            (13_000, false)
        ]
    );
}

#[test]
fn trace_stub_replays_a_recorded_signal() {
    // Record the blinker's pin in one run, then feed it to a circuit-only run.
    let (bus, units) = blink_device(11);
    let mut source = Kernel::new(bus, units, KernelConfig::default()).unwrap();
    source.run_until(SimTime(60 * MS)).unwrap();
    let pin = source.bus().id("pin").unwrap();
    let recorded = source.bus().changes(pin).to_vec();
    let v_source = source.bus().changes(source.bus().id("v").unwrap()).to_vec();

    let (mut bus, units) = blink_device(99);
    let mut scope = Scope::only("circuit only", &[Domain::Circuit, Domain::Parts]);
    scope.stubs.insert(
        "pin".into(),
        StubSpec::Trace {
            changes: recorded.clone(),
        },
    );
    let cut = cut(&mut bus, units, Vec::new(), &scope, &BTreeMap::new()).unwrap();
    assert_eq!(cut.left_out, vec!["blinker".to_owned()]);
    let mut replay = Kernel::new(bus, cut.units, KernelConfig::default()).unwrap();
    replay.run_until(SimTime(60 * MS)).unwrap();
    assert_eq!(replay.bus().changes(pin), recorded.as_slice());
    // The circuit saw exactly what the firmware fed it, so it did the same: compare
    // its voltage at every edge (both runs stop their coupling steps there).
    let v = replay.bus().id("v").unwrap();
    let at_edges = |changes: &[Change]| -> Vec<(SimTime, f64)> {
        changes
            .iter()
            .filter(|c| recorded.iter().any(|e| e.t == c.t))
            .map(|c| (c.t, c.value.as_real()))
            .collect()
    };
    let (a, b) = (at_edges(&v_source), at_edges(replay.bus().changes(v)));
    assert!(a.len() > 20 && a.len() == b.len());
    for ((ta, va), (tb, vb)) in a.iter().zip(&b) {
        assert_eq!(ta, tb);
        assert!((va - vb).abs() < 1e-9, "{va} vs {vb} at {ta}");
    }
}

#[test]
fn ideal_stubs() {
    // An ideal source holds its value whatever reads it.
    let spec = StubSpec::Ideal {
        model: IdealModel::Source {
            value: Value::Logic(Logic::High),
        },
        reads: None,
    };
    let (mut k, x) = stub_kernel(&spec, SignalKind::Logic, Value::Logic(Logic::Low));
    k.run_until(SimTime(5 * MS)).unwrap();
    assert_eq!(k.bus().get(x), Value::Logic(Logic::High));

    // An ideal rotor settles at τ = b·ω (no drag): 2 mN·m / 1e-5 N·m·s = 200 rad/s,
    // with time constant J/b = 0.1 s.
    let spec = StubSpec::Ideal {
        model: IdealModel::Rotor {
            inertia: 1e-6,
            damping: 1e-5,
            drag: 0.0,
        },
        reads: Some("torque".into()),
    };
    let (mut k, x) = stub_kernel(&spec, SignalKind::Real, Value::Real(0.0));
    k.run_until(SimTime(100 * MS)).unwrap();
    let after_tau = k.bus().real(x);
    assert!(
        (after_tau - 200.0 * (1.0 - (-1.0f64).exp())).abs() < 1.0,
        "{after_tau}"
    );
    k.run_until(SimTime(1000 * MS)).unwrap();
    assert!((k.bus().real(x) - 200.0).abs() < 0.1);
}

#[test]
fn scopes_cut_the_device() {
    let (mut bus, units) = blink_device(5);
    let whole = cut(
        &mut bus,
        units,
        Vec::new(),
        &Scope::whole_device(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert!(whole.stubs.is_empty() && whole.left_out.is_empty());

    // Code only: the circuit and the button are left out; the button input gets the
    // device's default stub (a control the virtual I/O panel drives).
    let (mut bus, units) = blink_device(5);
    let mut defaults = BTreeMap::new();
    defaults.insert(
        "button".to_owned(),
        StubSpec::Control {
            value: Value::Logic(Logic::Low),
            generator: None,
        },
    );
    let code = cut(
        &mut bus,
        units,
        Vec::new(),
        &Scope::only("Code only", &[Domain::Firmware]),
        &defaults,
    )
    .unwrap();
    assert_eq!(code.left_out, vec!["rc".to_owned(), "SW1".to_owned()]);
    assert_eq!(code.stubs.len(), 1);
    assert_eq!(code.stubs[0].kind, "control");

    // A host is cut like a unit.
    let (mut bus, units) = blink_device(5);
    let (pin, button) = (bus.id("pin").unwrap(), bus.id("button").unwrap());
    let host = HostSpec {
        name: "avr".into(),
        domain: Domain::Firmware,
        reads: vec![button],
        writes: vec![pin],
    };
    let circuit = cut(
        &mut bus,
        units.into_iter().skip(1).collect(),
        vec![host],
        &Scope::only("Circuit only", &[Domain::Circuit, Domain::Parts]),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(circuit.left_out, vec!["avr".to_owned()]);
    assert_eq!(circuit.stubs[0].signal, "pin");
    assert_eq!(circuit.stubs[0].kind, "hold");

    // Stubbing a signal a running part writes is an error.
    let (mut bus, units) = blink_device(5);
    let mut scope = Scope::whole_device();
    scope.stubs.insert("pin".into(), StubSpec::Open);
    assert!(cut(&mut bus, units, Vec::new(), &scope, &BTreeMap::new()).is_err());
}
