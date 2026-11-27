//! Node binding of Triage's simulation (ROADMAP P3-2 to P3-6): a [`Simulation`]
//! is a device built for a scope, run by the caller in grant / complete steps
//! with the AVR emulator as the kernel's host (`sim/src/avr.ts`), or on its own
//! with `runUntil` when the scope leaves the firmware out.
//!
//! Times cross as numbers of picoseconds (exact up to 2⁵³ ps, about 2.5 hours of
//! virtual time). Logic levels cross as numbers: 0 low, 1 high, 2 high
//! impedance, 3 weak low, 4 weak high.
//!
//! Built as `triage_sim.node` by `crates/triage-sim-node/build.mjs`.
// napi-derive expands to the FFI glue Node needs, which is unsafe code.
#![allow(unsafe_code)]
// napi passes JavaScript strings and numbers by value, and numbers are f64.
#![allow(
    clippy::needless_pass_by_value,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::must_use_candidate
)]

use napi::bindgen_prelude::{Float64Array, Uint32Array};
use napi::{Error, Result, Status};
use napi_derive::napi;
use triage_sim::{BuildOptions, DeviceSpec, build};
use triage_sim_kernel::{
    HostReport, Kernel, KernelConfig, Logic, Scope, SignalId, SimDuration, SimTime, Value,
};

fn error(message: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, message.to_string())
}

#[allow(clippy::cast_possible_truncation)]
fn time(ps: f64) -> SimTime {
    SimTime(ps.round() as i64)
}

#[allow(clippy::cast_precision_loss)]
fn ps(t: SimTime) -> f64 {
    t.0 as f64
}

/// A value as (kind, number): kind 0 is a logic level, 1 a number.
fn encode(value: Value) -> (f64, f64) {
    match value {
        Value::Logic(l) => (
            0.0,
            match l {
                Logic::Low => 0.0,
                Logic::High => 1.0,
                Logic::Z => 2.0,
                Logic::WeakLow => 3.0,
                Logic::WeakHigh => 4.0,
            },
        ),
        Value::Real(x) => (1.0, x),
    }
}

#[allow(clippy::float_cmp)]
fn decode(kind: f64, number: f64) -> Value {
    if kind == 0.0 {
        Value::Logic(match number as u8 {
            0 => Logic::Low,
            1 => Logic::High,
            3 => Logic::WeakLow,
            4 => Logic::WeakHigh,
            _ => Logic::Z,
        })
    } else {
        Value::Real(number)
    }
}

/// Build options as JSON: `{ "quantumMaxUs", "quantumMinUs", "couplingStepUs", "mujoco", "trace" }`.
fn options(json: Option<&str>) -> Result<BuildOptions> {
    let mut options = BuildOptions::default();
    let Some(json) = json else {
        return Ok(options);
    };
    let value: serde_json::Value = serde_json::from_str(json).map_err(error)?;
    let us = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .map(|v| SimDuration::from_seconds(v * 1e-6))
    };
    let mut config = KernelConfig::default();
    if let Some(q) = us("quantumMaxUs") {
        config.quantum_max = q;
    }
    if let Some(q) = us("quantumMinUs") {
        config.quantum_min = q;
    }
    if let Some(q) = us("couplingStepUs") {
        config.coupling_step = q;
    }
    options.config = config;
    if let Some(m) = value.get("mujoco").and_then(serde_json::Value::as_bool) {
        options.mujoco = m && triage_sim::mechanics::has_mujoco();
    }
    if let Some(t) = value.get("trace").and_then(serde_json::Value::as_bool) {
        options.trace_all = t;
    }
    Ok(options)
}

/// A simulated device, built for a scope.
#[napi]
pub struct Simulation {
    kernel: Kernel,
    info: String,
    hosts: usize,
}

#[napi]
impl Simulation {
    /// Builds a device (`DeviceSpec` JSON) for a scope (`Scope` JSON).
    ///
    /// # Errors
    /// When the description or scope doesn't parse or doesn't fit.
    #[napi(constructor)]
    pub fn new(device: String, scope: String, options_json: Option<String>) -> Result<Simulation> {
        let device: DeviceSpec =
            serde_json::from_str(&device).map_err(|e| error(format!("device: {e}")))?;
        let scope: Scope =
            serde_json::from_str(&scope).map_err(|e| error(format!("scope: {e}")))?;
        let built = build(&device, &scope, &options(options_json.as_deref())?).map_err(error)?;
        let info = serde_json::to_string(&built.info).map_err(error)?;
        let hosts = built.info.hosts.len();
        Ok(Simulation {
            kernel: built.kernel,
            info,
            hosts,
        })
    }

    /// What runs, the host's pins, stubs, controls, signals (`DeviceInfo` JSON).
    #[napi]
    pub fn info(&self) -> String {
        self.info.clone()
    }

    /// The kernel's time, ps.
    #[napi]
    pub fn now(&self) -> f64 {
        ps(self.kernel.now())
    }

    /// Grant phase: `[from, until]` in ps.
    ///
    /// # Errors
    /// When the last grant wasn't completed.
    #[napi]
    pub fn grant(&mut self) -> Result<Vec<f64>> {
        let g = self.kernel.grant().map_err(error)?;
        Ok(vec![ps(g.from), ps(g.until)])
    }

    /// Sync and unblock: the host's report (`events` as quads: time ps, signal id,
    /// kind, value). Returns `[now, count, (signal, kind, value) × count]`: the
    /// host's inputs that changed.
    ///
    /// # Errors
    /// For a report that doesn't fit the grant.
    #[napi]
    pub fn complete(
        &mut self,
        host: u32,
        reached: f64,
        events: Float64Array,
    ) -> Result<Float64Array> {
        let events: Vec<(SimTime, SignalId, Value)> = events
            .chunks_exact(4)
            .map(|e| (time(e[0]), SignalId(e[1] as u32), decode(e[2], e[3])))
            .collect();
        let reports = if (host as usize) < self.hosts {
            vec![HostReport {
                host,
                reached: time(reached),
                events,
            }]
        } else {
            Vec::new()
        };
        let unblock = self.kernel.complete(reports).map_err(error)?;
        let changed = unblock
            .hosts
            .get(host as usize)
            .map(|h| h.changed.as_slice())
            .unwrap_or_default();
        let mut out = Vec::with_capacity(2 + 3 * changed.len());
        out.push(ps(unblock.now));
        #[allow(clippy::cast_precision_loss)]
        out.push(changed.len() as f64);
        for (signal, value) in changed {
            let (kind, number) = encode(*value);
            out.extend([f64::from(signal.0), kind, number]);
        }
        Ok(Float64Array::new(out))
    }

    /// Queues a control change at time `t` ps (now, if passed).
    ///
    /// # Errors
    /// When no unit has the control.
    #[napi]
    pub fn input(&mut self, t: f64, control: String, value: f64) -> Result<()> {
        self.kernel.input(time(t), &control, value).map_err(error)
    }

    /// Runs to `t` ps (only when the scope leaves the firmware out).
    ///
    /// # Errors
    /// When the scope runs the firmware (a host is present).
    #[napi]
    pub fn run_until(&mut self, t: f64) -> Result<()> {
        self.kernel.run_until(time(t)).map_err(error)
    }

    /// A signal's value (logic levels as numbers), or null when it doesn't exist.
    #[napi]
    pub fn value(&self, signal: String) -> Option<f64> {
        let bus = self.kernel.bus();
        bus.id(&signal).map(|id| encode(bus.get(id)).1)
    }

    /// Values of signals by id.
    #[napi]
    pub fn values(&self, ids: Uint32Array) -> Float64Array {
        let bus = self.kernel.bus();
        let count = u32::try_from(bus.len()).unwrap_or(u32::MAX);
        Float64Array::new(
            ids.iter()
                .map(|&id| {
                    if id < count {
                        encode(bus.get(SignalId(id))).1
                    } else {
                        f64::NAN
                    }
                })
                .collect(),
        )
    }

    /// A traced signal's changes from `from` ps on (with the value in force at
    /// `from` first), as pairs: time ps, value.
    #[napi]
    pub fn trace(&self, signal: String, from: Option<f64>) -> Float64Array {
        let bus = self.kernel.bus();
        let Some(id) = bus.id(&signal) else {
            return Float64Array::new(Vec::new());
        };
        let changes = bus.changes(id);
        let from = time(from.unwrap_or(0.0));
        let start = changes.partition_point(|c| c.t <= from).saturating_sub(1);
        let mut out = Vec::with_capacity(2 * (changes.len() - start));
        for c in &changes[start..] {
            out.push(ps(c.t));
            out.push(encode(c.value).1);
        }
        Float64Array::new(out)
    }

    /// Forgets trace entries before `t` ps (long interactive runs).
    #[napi]
    pub fn trim_traces(&mut self, t: f64) {
        self.kernel.bus_mut().trim_traces(time(t));
    }

    /// Readouts of every unit, JSON `{ "circuit.R1.current": 0.00025, … }`.
    #[napi]
    pub fn readouts(&self) -> String {
        let map: serde_json::Map<String, serde_json::Value> = self
            .kernel
            .readouts()
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::from(v)))
            .collect();
        serde_json::Value::Object(map).to_string()
    }

    /// The inputs applied so far, JSON (replaying them reproduces the run).
    #[napi]
    pub fn recording(&self) -> String {
        let inputs: Vec<serde_json::Value> = self
            .kernel
            .recording()
            .iter()
            .map(|i| serde_json::json!({ "t": ps(i.t), "control": i.control, "value": i.value }))
            .collect();
        serde_json::Value::Array(inputs).to_string()
    }

    /// Scheduler counters and the current quantum, JSON.
    #[napi]
    pub fn stats(&self) -> String {
        let s = self.kernel.stats();
        serde_json::json!({
            "quanta": s.quanta,
            "events": s.events,
            "couplingSteps": s.coupling_steps,
            "quantumPs": self.kernel.quantum().0,
        })
        .to_string()
    }

    /// A hash of every trace, hex (equal hashes: equal histories).
    #[napi]
    pub fn trace_hash(&self) -> String {
        format!("{:016x}", self.kernel.bus().trace_hash())
    }
}

/// The addon's version, and whether it carries MuJoCo.
#[napi]
pub fn version() -> String {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "mujoco": triage_sim::mechanics::has_mujoco(),
    })
    .to_string()
}
