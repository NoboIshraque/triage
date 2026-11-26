//! The scheduler: conservative quantum synchronization in explicit grant, sync
//! and unblock phases (PLAN §4.7, after Renode's `TimeSourceBase`).
//!
//! 1. **Grant.** Each producer (MCU, signal generator) may run from its own time
//!    up to the quantum's end. It stops early at its first output event, or when it
//!    needs an input now (an ADC conversion: sync on demand).
//! 2. **Sync.** The kernel takes the earliest time any producer reached. Continuous
//!    units (circuit, physics, environment) catch up to each event with held
//!    inputs, in coupling steps, the event is applied, and so on up to that time.
//! 3. **Unblock.** Producers get the inputs that changed (pin levels, voltages).
//!
//! Producers in Rust run inside [`Kernel::grant`]. Producers outside it (the AVR
//! emulator in JavaScript) are **hosts**: the caller runs them between
//! [`Kernel::grant`] and [`Kernel::complete`] and reports their events.
//!
//! The quantum adapts between its bounds: it halves when a producer's inputs
//! changed in the last sync (something is happening it should see soon) and
//! doubles back up when they didn't.

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::signal::{SignalBus, SignalId, Value};
use crate::time::{SimDuration, SimTime};
use crate::unit::{Domain, Event, StepContext, Unit, UnitKind};

/// Scheduler settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelConfig {
    /// Longest quantum (default 1 ms).
    pub quantum_max: SimDuration,
    /// Shortest quantum (default 1 µs).
    pub quantum_min: SimDuration,
    /// Longest step continuous units take between exchanges (default 50 µs).
    pub coupling_step: SimDuration,
}

impl Default for KernelConfig {
    fn default() -> KernelConfig {
        KernelConfig {
            quantum_max: SimDuration::from_millis(1),
            quantum_min: SimDuration::from_micros(1),
            coupling_step: SimDuration::from_micros(50),
        }
    }
}

/// A producer outside the kernel, run by the caller between grant and complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HostId(pub u32);

/// What the caller may run its hosts up to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// Where the quantum starts (the kernel's time).
    pub from: SimTime,
    /// Where it ends.
    pub until: SimTime,
}

/// A host's report for one quantum.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct HostReport {
    /// Which host.
    pub host: u32,
    /// The time it reached (≤ the grant's end).
    pub reached: SimTime,
    /// Its outputs, in time order, each at or before `reached`.
    pub events: Vec<(SimTime, SignalId, Value)>,
}

/// The inputs that changed for one host.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct HostInputs {
    /// Which host.
    pub host: u32,
    /// Signals it reads whose value changed since it was last told, with the new value.
    pub changed: Vec<(SignalId, Value)>,
}

/// The kernel's answer to [`Kernel::complete`].
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Unblock {
    /// The kernel's time now (every continuous unit is here).
    pub now: SimTime,
    /// Per host, the inputs that changed.
    pub hosts: Vec<HostInputs>,
}

/// A control set from outside (UI, scenario), applied at a quantum boundary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Input {
    /// When it takes effect (the first quantum boundary at or after this time).
    pub t: SimTime,
    /// The control's name (a unit's control).
    pub control: String,
    /// Its value.
    pub value: f64,
}

/// Errors from the kernel's API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelError {
    /// `complete` without `grant`, or `grant` twice.
    Phase(&'static str),
    /// A report names a host the kernel doesn't have.
    UnknownHost(u32),
    /// A host reported a time outside its grant, or events out of order.
    BadReport(String),
    /// No unit has this control.
    UnknownControl(String),
    /// `run_until` needs every producer inside the kernel.
    HostsPresent,
    /// Two units write the same signal.
    TwoWriters(String),
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KernelError::Phase(what) => write!(f, "kernel phase error: {what}"),
            KernelError::UnknownHost(h) => write!(f, "unknown host {h}"),
            KernelError::BadReport(why) => write!(f, "bad host report: {why}"),
            KernelError::UnknownControl(c) => write!(f, "no unit has the control \"{c}\""),
            KernelError::HostsPresent => {
                write!(
                    f,
                    "run_until needs every producer in the kernel; use grant and complete"
                )
            }
            KernelError::TwoWriters(s) => write!(f, "two units write the signal \"{s}\""),
        }
    }
}

impl std::error::Error for KernelError {}

struct Slot {
    unit: Box<dyn Unit>,
    /// A producer's own time (continuous units are always at the kernel's time).
    local: SimTime,
}

struct Host {
    name: String,
    domain: Domain,
    reads: Vec<SignalId>,
    writes: Vec<SignalId>,
    local: SimTime,
    /// The version of each read signal the host was last told about.
    told: Vec<u64>,
}

/// Counters for benchmarks and the UI.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelStats {
    /// Quanta completed.
    pub quanta: u64,
    /// Events applied.
    pub events: u64,
    /// Continuous coupling steps taken.
    pub coupling_steps: u64,
}

/// The co-simulation kernel.
pub struct Kernel {
    bus: SignalBus,
    slots: Vec<Slot>,
    hosts: Vec<Host>,
    config: KernelConfig,
    now: SimTime,
    quantum: SimDuration,
    granted: Option<Grant>,
    /// Events not yet applied, sorted by time (stable: emission order breaks ties).
    pending: Vec<Event>,
    queued: Vec<Input>,
    applied: Vec<Input>,
    controls: HashMap<String, usize>,
    stats: KernelStats,
    /// Every signal some producer reads (inside or host), for the adaptive quantum.
    producer_reads: Vec<(SignalId, u64)>,
}

impl Kernel {
    /// A kernel over these units. Fails if two units write the same signal.
    ///
    /// # Errors
    /// [`KernelError::TwoWriters`] when signals have more than one writer.
    pub fn new(
        bus: SignalBus,
        units: Vec<Box<dyn Unit>>,
        config: KernelConfig,
    ) -> Result<Kernel, KernelError> {
        let mut writers: HashMap<SignalId, usize> = HashMap::new();
        let mut controls = HashMap::new();
        for (i, unit) in units.iter().enumerate() {
            for signal in unit.writes() {
                if writers.insert(signal, i).is_some() {
                    return Err(KernelError::TwoWriters(bus.name(signal).to_owned()));
                }
            }
            for control in unit.controls() {
                controls.insert(control, i);
            }
        }
        let mut kernel = Kernel {
            bus,
            slots: units
                .into_iter()
                .map(|unit| Slot {
                    unit,
                    local: SimTime::ZERO,
                })
                .collect(),
            hosts: Vec::new(),
            config,
            now: SimTime::ZERO,
            quantum: config.quantum_max,
            granted: None,
            pending: Vec::new(),
            queued: Vec::new(),
            applied: Vec::new(),
            controls,
            stats: KernelStats::default(),
            producer_reads: Vec::new(),
        };
        kernel.refresh_producer_reads();
        Ok(kernel)
    }

    /// Adds a producer run outside the kernel.
    ///
    /// # Errors
    /// [`KernelError::TwoWriters`] when it writes a signal a unit already writes.
    pub fn add_host(
        &mut self,
        name: &str,
        domain: Domain,
        reads: Vec<SignalId>,
        writes: Vec<SignalId>,
    ) -> Result<HostId, KernelError> {
        for &signal in &writes {
            let taken = self.slots.iter().any(|s| s.unit.writes().contains(&signal))
                || self.hosts.iter().any(|h| h.writes.contains(&signal));
            if taken {
                return Err(KernelError::TwoWriters(self.bus.name(signal).to_owned()));
            }
        }
        let told = vec![u64::MAX; reads.len()];
        self.hosts.push(Host {
            name: name.to_owned(),
            domain,
            reads,
            writes,
            local: self.now,
            told,
        });
        self.refresh_producer_reads();
        Ok(HostId(
            u32::try_from(self.hosts.len() - 1).unwrap_or(u32::MAX),
        ))
    }

    fn refresh_producer_reads(&mut self) {
        let mut reads: Vec<SignalId> = self
            .slots
            .iter()
            .filter(|s| s.unit.kind() == UnitKind::Producer)
            .flat_map(|s| s.unit.reads())
            .chain(self.hosts.iter().flat_map(|h| h.reads.iter().copied()))
            .collect();
        reads.sort_unstable();
        reads.dedup();
        self.producer_reads = reads
            .into_iter()
            .map(|id| (id, self.bus.version(id)))
            .collect();
    }

    /// The bus (signal values and traces).
    #[must_use]
    pub fn bus(&self) -> &SignalBus {
        &self.bus
    }

    /// The bus, to start tracing signals.
    pub fn bus_mut(&mut self) -> &mut SignalBus {
        &mut self.bus
    }

    /// The kernel's time.
    #[must_use]
    pub fn now(&self) -> SimTime {
        self.now
    }

    /// The current quantum.
    #[must_use]
    pub fn quantum(&self) -> SimDuration {
        self.quantum
    }

    /// Counters.
    #[must_use]
    pub fn stats(&self) -> KernelStats {
        self.stats
    }

    /// The scheduler's settings.
    #[must_use]
    pub fn config(&self) -> KernelConfig {
        self.config
    }

    /// Names, domains and kinds of the units (and hosts, as producers).
    #[must_use]
    pub fn units(&self) -> Vec<(String, Domain, UnitKind)> {
        self.slots
            .iter()
            .map(|s| (s.unit.name().to_owned(), s.unit.domain(), s.unit.kind()))
            .chain(
                self.hosts
                    .iter()
                    .map(|h| (h.name.clone(), h.domain, UnitKind::Producer)),
            )
            .collect()
    }

    /// Every unit's readouts, prefixed with the unit's name (`circuit.R1.current`).
    #[must_use]
    pub fn readouts(&self) -> Vec<(String, f64)> {
        self.slots
            .iter()
            .flat_map(|s| {
                let name = s.unit.name();
                s.unit
                    .readouts()
                    .into_iter()
                    .map(move |(k, v)| (format!("{name}.{k}"), v))
            })
            .collect()
    }

    /// Every control the units accept.
    #[must_use]
    pub fn controls(&self) -> Vec<String> {
        let mut names: Vec<String> = self.controls.keys().cloned().collect();
        names.sort();
        names
    }

    /// Queues a control change at virtual time `t` (now, if `t` has passed). It takes
    /// effect at the first quantum boundary at or after `t`, and is recorded there.
    ///
    /// # Errors
    /// [`KernelError::UnknownControl`] when no unit has it.
    pub fn input(&mut self, t: SimTime, control: &str, value: f64) -> Result<(), KernelError> {
        if !self.controls.contains_key(control) {
            return Err(KernelError::UnknownControl(control.to_owned()));
        }
        let t = t.max(self.now);
        let at = self.queued.partition_point(|q| q.t <= t);
        self.queued.insert(
            at,
            Input {
                t,
                control: control.to_owned(),
                value,
            },
        );
        Ok(())
    }

    /// The inputs applied so far, with the time each took effect. Queuing them in a
    /// fresh kernel with the same units replays the run exactly.
    #[must_use]
    pub fn recording(&self) -> &[Input] {
        &self.applied
    }

    fn apply_inputs(&mut self) {
        let due = self.queued.partition_point(|q| q.t <= self.now);
        for mut input in self.queued.drain(..due).collect::<Vec<_>>() {
            if let Some(&i) = self.controls.get(&input.control) {
                self.slots[i].unit.control(&input.control, input.value);
                input.t = self.now;
                self.applied.push(input);
            }
        }
    }

    /// The next quantum boundary any queued input asks for.
    fn next_input_time(&self) -> Option<SimTime> {
        self.queued.first().map(|q| q.t)
    }

    /// **Grant phase.** Applies due inputs, then runs the kernel's own producers up to
    /// the quantum's end (or their first event). Hosts may now run up to `until`.
    ///
    /// # Errors
    /// [`KernelError::Phase`] when the previous grant wasn't completed.
    pub fn grant(&mut self) -> Result<Grant, KernelError> {
        self.grant_limited(SimTime::MAX)
    }

    fn grant_limited(&mut self, limit: SimTime) -> Result<Grant, KernelError> {
        if self.granted.is_some() {
            return Err(KernelError::Phase(
                "grant before the last grant was completed",
            ));
        }
        self.apply_inputs();
        let mut until = (self.now + self.quantum).min(limit);
        if let Some(t) = self.next_input_time()
            && t > self.now
            && t < until
        {
            until = t;
        }
        for slot in &mut self.slots {
            if slot.unit.kind() != UnitKind::Producer || slot.local >= until {
                continue;
            }
            let mut events = Vec::new();
            let mut ctx = StepContext {
                bus: &mut self.bus,
                now: slot.local,
                until,
                events: &mut events,
            };
            let reached = slot.unit.step(&mut ctx).clamp(slot.local, until);
            slot.local = reached;
            insert_events(&mut self.pending, events);
        }
        let grant = Grant {
            from: self.now,
            until,
        };
        self.granted = Some(grant);
        Ok(grant)
    }

    /// **Sync and unblock phases.** Takes the hosts' reports, advances continuous
    /// units through every event up to the earliest time a producer reached, and
    /// returns the inputs that changed for each host.
    ///
    /// # Errors
    /// [`KernelError::Phase`] without a grant; [`KernelError::UnknownHost`] or
    /// [`KernelError::BadReport`] for a report that doesn't fit the grant.
    pub fn complete(&mut self, reports: Vec<HostReport>) -> Result<Unblock, KernelError> {
        let Some(grant) = self.granted else {
            return Err(KernelError::Phase("complete without a grant"));
        };
        for report in reports {
            let host = self
                .hosts
                .get_mut(report.host as usize)
                .ok_or(KernelError::UnknownHost(report.host))?;
            if report.reached < host.local || report.reached > grant.until {
                return Err(KernelError::BadReport(format!(
                    "{} reached {} outside its grant ({} to {})",
                    host.name, report.reached, host.local, grant.until
                )));
            }
            let mut events = Vec::with_capacity(report.events.len());
            let mut last = host.local;
            for (t, signal, value) in report.events {
                if t < last || t > report.reached || !host.writes.contains(&signal) {
                    return Err(KernelError::BadReport(format!(
                        "{}: event on {} at {t} out of order or not its own",
                        host.name,
                        self.bus.name(signal)
                    )));
                }
                last = t;
                events.push(Event { t, signal, value });
            }
            host.local = report.reached;
            insert_events(&mut self.pending, events);
        }
        self.granted = None;

        let target = self
            .slots
            .iter()
            .filter(|s| s.unit.kind() == UnitKind::Producer)
            .map(|s| s.local)
            .chain(self.hosts.iter().map(|h| h.local))
            .min()
            .unwrap_or(grant.until)
            .min(grant.until)
            .max(self.now);
        self.sync_to(target);
        self.stats.quanta += 1;

        // Adaptive quantum: halve when a producer's inputs changed, else grow back.
        let mut changed = false;
        for (id, version) in &mut self.producer_reads {
            let now = self.bus.version(*id);
            if now != *version {
                changed = true;
                *version = now;
            }
        }
        self.quantum = if changed {
            SimDuration((self.quantum.0 / 2).max(self.config.quantum_min.0))
        } else {
            SimDuration((self.quantum.0 * 2).min(self.config.quantum_max.0))
        };

        let mut hosts = Vec::with_capacity(self.hosts.len());
        for (i, host) in self.hosts.iter_mut().enumerate() {
            let mut inputs = HostInputs {
                host: u32::try_from(i).unwrap_or(u32::MAX),
                changed: Vec::new(),
            };
            for (k, &id) in host.reads.iter().enumerate() {
                let version = self.bus.version(id);
                if host.told[k] != version {
                    host.told[k] = version;
                    inputs.changed.push((id, self.bus.get(id)));
                }
            }
            hosts.push(inputs);
        }
        Ok(Unblock {
            now: self.now,
            hosts,
        })
    }

    /// Applies pending events up to `target` and advances continuous units there.
    fn sync_to(&mut self, target: SimTime) {
        while let Some(first) = self.pending.first().copied() {
            if first.t > target {
                break;
            }
            self.advance_continuous(first.t);
            let end = self.pending.partition_point(|e| e.t <= first.t);
            for event in self.pending.drain(..end) {
                self.bus.set(event.signal, event.t, event.value);
                self.stats.events += 1;
            }
        }
        self.advance_continuous(target);
    }

    fn advance_continuous(&mut self, to: SimTime) {
        while self.now < to {
            let step = (to - self.now).min(self.config.coupling_step);
            let until = self.now + step;
            for slot in &mut self.slots {
                if slot.unit.kind() != UnitKind::Continuous {
                    continue;
                }
                let mut ignored = Vec::new();
                let mut ctx = StepContext {
                    bus: &mut self.bus,
                    now: self.now,
                    until,
                    events: &mut ignored,
                };
                slot.unit.step(&mut ctx);
                slot.local = until;
            }
            self.now = until;
            self.stats.coupling_steps += 1;
        }
    }

    /// Runs every unit up to `t` (when all producers are inside the kernel).
    ///
    /// # Errors
    /// [`KernelError::HostsPresent`] when hosts were added.
    pub fn run_until(&mut self, t: SimTime) -> Result<(), KernelError> {
        if !self.hosts.is_empty() {
            return Err(KernelError::HostsPresent);
        }
        while self.now < t {
            self.grant_limited(t)?;
            self.complete(Vec::new())?;
        }
        Ok(())
    }
}

/// Inserts events into a time-sorted list, after any with the same time.
fn insert_events(pending: &mut Vec<Event>, events: Vec<Event>) {
    for event in events {
        let at = pending.partition_point(|e| e.t <= event.t);
        pending.insert(at, event);
    }
}
