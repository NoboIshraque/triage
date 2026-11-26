//! P3-3 done-when (the thermistor divider reads the right ADC value; LED current is
//! correct) and the device's circuit, mechanics and scopes, without the MCU (the
//! AVR unit is tested with them in sim/).
#![allow(clippy::unwrap_used, clippy::cast_possible_truncation)]

use std::collections::BTreeMap;

use triage_sim::spec::{BoardPin, BoardSpec, DeviceSpec, PartSpec, RailPin};
use triage_sim::{BuildOptions, build};
use triage_sim_kernel::{
    Domain, Generator, HostReport, Kernel, Logic, Scope, SimDuration, SimTime, StubSpec, Value,
};

const MS: i64 = 1_000_000_000;

fn smart_fan() -> DeviceSpec {
    serde_json::from_str(include_str!("fixtures/smart-fan.device.json")).unwrap()
}

fn circuit_only() -> Scope {
    Scope::only(
        "Circuit only",
        &[Domain::Circuit, Domain::Environment, Domain::Parts],
    )
}

/// What the firmware's `analogRead` returns for a voltage (10 bits, 5 V reference).
fn adc(volts: f64) -> i64 {
    ((volts / 5.0 * 1024.0).floor() as i64).clamp(0, 1023)
}

fn volts(kernel: &Kernel, signal: &str) -> f64 {
    kernel.bus().real(kernel.bus().id(signal).unwrap())
}

fn ntc_ohms(celsius: f64) -> f64 {
    10_000.0 * (3950.0 * (1.0 / (celsius + 273.15) - 1.0 / 298.15)).exp()
}

#[test]
fn the_thermistor_divider_reads_the_right_adc_value() {
    let device = build(&smart_fan(), &circuit_only(), &BuildOptions::default()).unwrap();
    let mut k = device.kernel;
    for celsius in [20.0, 24.0, 25.0, 30.0, 35.0, 40.0] {
        k.input(k.now(), "env.room_temperature_c", celsius).unwrap();
        k.run_until(k.now() + SimDuration(10 * MS)).unwrap();
        let expected = 5.0 * 10_000.0 / (10_000.0 + ntc_ohms(celsius));
        let v = volts(&k, "net:/TEMP_SENSE");
        // The ADC pin draws nothing (an undriven input).
        assert!(
            (v - expected).abs() < 1e-4,
            "{celsius} °C: {v} V, expected {expected} V"
        );
        // Within one count (an exact 2.5 V at 25 °C sits on the 511/512 boundary).
        assert!(
            (adc(v) - adc(expected)).abs() <= 1,
            "{celsius} °C: {} vs {}",
            adc(v),
            adc(expected)
        );
    }
    // 35 °C: 6.5 kΩ against 10 kΩ, about 3.03 V: count 620.
    k.input(k.now(), "env.room_temperature_c", 35.0).unwrap();
    k.run_until(k.now() + SimDuration(MS)).unwrap();
    assert_eq!(adc(volts(&k, "net:/TEMP_SENSE")), 620);
}

fn led_device(ohms: f64) -> DeviceSpec {
    DeviceSpec {
        name: "LED".into(),
        ground: "GND".into(),
        board: Some(BoardSpec {
            reference: "A1".into(),
            profile: "arduino-uno".into(),
            pins: vec![BoardPin {
                name: "D13".into(),
                net: "LED_PIN".into(),
                analog: false,
                pwm: false,
            }],
            regulator: Some(RailPin {
                net: "+5V".into(),
                volts: 5.0,
            }),
            vin: None,
            quiescent_a: None,
        }),
        parts: vec![
            PartSpec {
                reference: "R4".into(),
                model: "resistor".into(),
                params: BTreeMap::from([("ohms".into(), ohms)]),
                pins: BTreeMap::from([
                    ("a".into(), "LED_PIN".into()),
                    ("b".into(), "LED_A".into()),
                ]),
            },
            PartSpec {
                reference: "D2".into(),
                model: "led".into(),
                params: BTreeMap::new(),
                pins: BTreeMap::from([
                    ("anode".into(), "LED_A".into()),
                    ("cathode".into(), "GND".into()),
                ]),
            },
        ],
        ..DeviceSpec::default()
    }
}

#[test]
fn led_current_is_correct() {
    for ohms in [220.0, 330.0, 1000.0] {
        let mut scope = circuit_only();
        scope.stubs.insert(
            "pin:D13".into(),
            StubSpec::Control {
                value: Value::Logic(Logic::High),
                generator: None,
            },
        );
        let device = build(&led_device(ohms), &scope, &BuildOptions::default()).unwrap();
        let mut k = device.kernel;
        k.run_until(SimTime(MS)).unwrap();
        let vf = volts(&k, "net:LED_A");
        // Kirchhoff with the pin's 25 Ω output resistance.
        let i = (5.0 - vf) / (ohms + 25.0);
        // Shockley's law at that current: Vf = n·Vt·ln(I/Is) + I·Rs.
        let shockley = 2.0 * 0.025_852 * (i / 1e-18).ln() + i * 5.0;
        assert!(
            (vf - shockley).abs() < 1e-3,
            "{ohms} Ω: Vf {vf}, Shockley {shockley}"
        );
        assert!(vf > 1.75 && vf < 2.05, "a red LED's forward drop: {vf}");
        let readout = k
            .readouts()
            .into_iter()
            .find(|(n, _)| n == "circuit.D2.current")
            .unwrap()
            .1;
        assert!((readout - i).abs() < 1e-6, "{readout} vs {i}");
        let brightness = volts(&k, "D2.brightness");
        assert!((brightness - i / 0.02).abs() < 1e-6);
        // Pin low: dark.
        k.input(k.now(), "pin:D13.value", 0.0).ok();
        k.input(k.now(), "A1.D13.drive.value", 0.0).unwrap();
        k.run_until(k.now() + SimDuration(MS)).unwrap();
        assert!(volts(&k, "D2.brightness") < 1e-6);
    }
}

fn fan_speed(duty: f64, mujoco: bool) -> (f64, f64) {
    let mut scope = Scope::only(
        "Circuit and mechanism",
        &[Domain::Circuit, Domain::Mechanics, Domain::Environment],
    );
    scope.stubs.insert(
        "net:FAN_PWM".into(),
        StubSpec::Control {
            value: Value::Logic(Logic::Low),
            generator: Some(Generator::Pwm {
                duty,
                freq_hz: 490.0,
            }),
        },
    );
    let options = BuildOptions {
        mujoco,
        ..BuildOptions::default()
    };
    let device = build(&smart_fan(), &scope, &options).unwrap();
    assert_eq!(
        device.info.mechanics_engine,
        if mujoco { "mujoco" } else { "builtin" }
    );
    let mut k = device.kernel;
    let mut peak = 0.0f64;
    let rail = k.bus().id("rail:/+12V.current").unwrap();
    for _ in 0..20 {
        k.run_until(k.now() + SimDuration(100 * MS)).unwrap();
        peak = peak.max(
            k.bus()
                .changes(rail)
                .iter()
                .map(|c| c.value.as_real())
                .fold(0.0, f64::max),
        );
        let now = k.now();
        k.bus_mut().trim_traces(now);
    }
    (volts(&k, "J1.omega"), peak)
}

#[test]
fn fan_speed_follows_pwm() {
    let speeds: Vec<(f64, f64)> = [0.0, 0.25, 0.5, 0.8, 1.0]
        .iter()
        .map(|&d| fan_speed(d, false))
        .collect();
    assert!(speeds[0].0.abs() < 1e-3, "off: {}", speeds[0].0);
    for pair in speeds.windows(2) {
        assert!(
            pair[1].0 > pair[0].0 + 10.0,
            "faster with more duty: {speeds:?}"
        );
    }
    // Full duty, steady state: Kt·(12 − Ke·ω − Vds)/R = b·ω + c·ω², Vds ≈ 22 mΩ·i.
    let omega = speeds[4].0;
    let i = (12.0 - 0.03 * omega) / (24.0 + 0.0225);
    let residual = 0.03 * i - (2e-6 * omega + 4e-8 * omega * omega);
    assert!(
        residual.abs() < 2e-5,
        "torque balance at {omega} rad/s: {residual}"
    );
    // Never near the 1.5 A of the overheat scenario (stall: 12 V / 24 Ω plus the board).
    for (_, peak) in &speeds {
        assert!(*peak < 1.0, "peak +12V current {peak}");
    }
}

#[test]
#[cfg(feature = "mujoco")]
fn mujoco_and_the_builtin_rotor_agree() {
    for duty in [0.3, 1.0] {
        let (builtin, _) = fan_speed(duty, false);
        let (mujoco, _) = fan_speed(duty, true);
        assert!(
            (builtin - mujoco).abs() / builtin < 0.01,
            "{duty}: {builtin} vs {mujoco}"
        );
    }
}

#[test]
fn the_button_pulls_its_pin_low() {
    let mut scope = circuit_only();
    scope.stubs.insert(
        "pin:D2".into(),
        StubSpec::Hold {
            value: Value::Logic(Logic::WeakHigh),
        },
    );
    let mut k = build(&smart_fan(), &scope, &BuildOptions::default())
        .unwrap()
        .kernel;
    k.run_until(SimTime(MS)).unwrap();
    assert!((volts(&k, "net:/BUTTON") - 5.0).abs() < 0.01);
    k.input(k.now(), "SW1.pressed", 1.0).unwrap();
    k.run_until(k.now() + SimDuration(MS)).unwrap();
    assert!(volts(&k, "net:/BUTTON") < 0.01);
}

#[test]
fn scopes_of_the_smart_fan() {
    let fan = smart_fan();
    let whole = build(&fan, &Scope::whole_device(), &BuildOptions::default()).unwrap();
    assert!(whole.info.stubs.is_empty(), "{:?}", whole.info.stubs);
    assert_eq!(whole.info.hosts.len(), 1);
    assert_eq!(whole.info.hosts[0].pins.len(), 5);
    assert!(whole.info.io_panel.is_empty());

    // Code only: the circuit, mechanism and environment are stubbed; the I/O
    // panel has the button, the thermistor's slider and the fan's indicator.
    let code = build(
        &fan,
        &Scope::only("Code only", &[Domain::Firmware, Domain::Parts]),
        &BuildOptions::default(),
    )
    .unwrap();
    assert!(code.info.left_out.contains(&"circuit".to_owned()));
    let kinds: Vec<(&str, &str)> = code
        .info
        .io_panel
        .iter()
        .map(|e| (e.kind, e.label.as_str()))
        .collect();
    assert!(kinds.contains(&("button", "BUTTON (D2)")), "{kinds:?}");
    assert!(kinds.contains(&("slider", "TEMP_SENSE (A0)")), "{kinds:?}");
    assert!(kinds.contains(&("indicator", "FAN_PWM (D9)")), "{kinds:?}");
    // The slider starts at the circuit's own voltage at 24 °C.
    let slider = code
        .info
        .io_panel
        .iter()
        .find(|e| e.kind == "slider")
        .unwrap();
    assert!((slider.value - 5.0 * 10_000.0 / (10_000.0 + ntc_ohms(24.0))).abs() < 1e-3);

    // Mechanism only: the torque is a control.
    let mech = build(
        &fan,
        &Scope::only("Mechanism only", &[Domain::Mechanics]),
        &BuildOptions::default(),
    )
    .unwrap();
    assert!(
        mech.info
            .stubs
            .iter()
            .any(|s| s.signal == "J1.torque" && s.kind == "control")
    );
    let mut k = mech.kernel;
    k.input(SimTime::ZERO, "J1.torque.value", 2e-3).unwrap();
    k.run_until(SimTime(2000 * MS)).unwrap();
    // τ = b ω + c ω²
    let omega = volts(&k, "J1.omega");
    assert!(
        (2e-3 - (2e-6 * omega + 4e-8 * omega * omega)).abs() < 2e-5,
        "{omega}"
    );
    assert!(volts(&k, "body:rotor.angle") > 100.0);
}

/// Whole device with a stand-in MCU host that drives D9 at 50% PWM: the host
/// protocol of the AVR unit, end to end.
#[test]
fn the_mcu_host_drives_the_fan() {
    let device = build(
        &smart_fan(),
        &Scope::whole_device(),
        &BuildOptions::default(),
    )
    .unwrap();
    let host = &device.info.hosts[0];
    let d9 = host.pins.iter().find(|p| p.name == "D9").unwrap();
    let drive = triage_sim_kernel::SignalId(d9.drive);
    let mut k = device.kernel;
    let mut level = false;
    let mut next_edge = SimTime::ZERO;
    let mut local = SimTime::ZERO;
    while k.now() < SimTime(1000 * MS) {
        let grant = k.grant().unwrap();
        let mut events = Vec::new();
        let mut reached = grant.until;
        if next_edge < grant.until {
            let t = next_edge.max(local);
            level = !level;
            events.push((
                t,
                drive,
                Value::Logic(if level { Logic::High } else { Logic::Low }),
            ));
            next_edge = t + SimDuration(1_020_408_163); // 490 Hz, 50%
            reached = t;
        }
        local = reached;
        k.complete(vec![HostReport {
            host: 0,
            reached,
            events,
        }])
        .unwrap();
        if k.now().0 % (100 * MS) < MS {
            let now = k.now();
            k.bus_mut().trim_traces(now);
        }
    }
    let omega = volts(&k, "J1.omega");
    let (half, _) = fan_speed(0.5, false);
    assert!((omega - half).abs() / half < 0.05, "{omega} vs {half}");
    assert!(k.stats().quanta > 900, "{:?}", k.stats());
}
