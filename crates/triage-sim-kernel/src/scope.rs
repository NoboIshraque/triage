//! Scopes: which parts of a device a run simulates (PLAN §4.7). The kernel
//! builds the co-simulation graph, cuts it at the scope's boundary, and puts a
//! stub on every signal that crosses it: a signal a kept unit reads whose writer
//! the scope leaves out.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::signal::{SignalBus, SignalId};
use crate::stub::{StubSpec, make_stub};
use crate::unit::{Domain, Unit};

/// A scope: the domains that run, and stubs chosen for particular signals.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Scope {
    /// Shown in the scope picker.
    pub name: String,
    /// Domains that run (`firmware`, `circuit`, `mechanics`, `environment`, `parts`).
    pub run: BTreeSet<Domain>,
    /// Stubs for particular signals, by signal name; others get the device's default.
    #[serde(default)]
    pub stubs: BTreeMap<String, StubSpec>,
}

impl Scope {
    /// Everything runs: nothing is stubbed.
    #[must_use]
    pub fn whole_device() -> Scope {
        Scope {
            name: "Whole device".into(),
            run: Domain::RUNNABLE.into_iter().collect(),
            stubs: BTreeMap::new(),
        }
    }

    /// Only these domains run.
    #[must_use]
    pub fn only(name: &str, domains: &[Domain]) -> Scope {
        Scope {
            name: name.into(),
            run: domains.iter().copied().collect(),
            stubs: BTreeMap::new(),
        }
    }

    /// Whether a unit of this domain runs (stubs always do).
    #[must_use]
    pub fn runs(&self, domain: Domain) -> bool {
        domain == Domain::Stub || self.run.contains(&domain)
    }
}

/// A producer that runs outside the kernel (see [`crate::kernel::Kernel::add_host`]).
#[derive(Clone, Debug, PartialEq)]
pub struct HostSpec {
    /// Its name.
    pub name: String,
    /// Its domain.
    pub domain: Domain,
    /// Signals it reads.
    pub reads: Vec<SignalId>,
    /// Signals it writes.
    pub writes: Vec<SignalId>,
}

/// One stub the cut inserted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StubInfo {
    /// The signal it writes.
    pub signal: String,
    /// `control`, `hold`, `trace`, `ideal` or `open`.
    pub kind: String,
}

/// The device, cut for a scope.
pub struct Cut {
    /// Units that run, with the stubs appended.
    pub units: Vec<Box<dyn Unit>>,
    /// Hosts that run.
    pub hosts: Vec<HostSpec>,
    /// The stubs inserted.
    pub stubs: Vec<StubInfo>,
    /// Names of units and hosts the scope leaves out.
    pub left_out: Vec<String>,
}

/// Cuts a device for a scope. `defaults` gives each boundary signal's stub when the
/// scope names none; a signal in neither holds the value it has on the bus.
///
/// # Errors
/// When the scope stubs a signal that a unit it runs writes, or a stub can't be built.
pub fn cut(
    bus: &mut SignalBus,
    units: Vec<Box<dyn Unit>>,
    hosts: Vec<HostSpec>,
    scope: &Scope,
    defaults: &BTreeMap<String, StubSpec>,
) -> Result<Cut, String> {
    let mut left_out = Vec::new();
    let mut kept: Vec<Box<dyn Unit>> = Vec::new();
    for unit in units {
        if scope.runs(unit.domain()) {
            kept.push(unit);
        } else {
            left_out.push(unit.name().to_owned());
        }
    }
    let mut kept_hosts = Vec::new();
    for host in hosts {
        if scope.runs(host.domain) {
            kept_hosts.push(host);
        } else {
            left_out.push(host.name.clone());
        }
    }

    let written: BTreeSet<SignalId> = kept
        .iter()
        .flat_map(|u| u.writes())
        .chain(kept_hosts.iter().flat_map(|h| h.writes.iter().copied()))
        .collect();
    for name in scope.stubs.keys() {
        let id = bus
            .id(name)
            .ok_or_else(|| format!("the scope stubs \"{name}\", which the device doesn't have"))?;
        if written.contains(&id) {
            return Err(format!(
                "the scope stubs \"{name}\", but a part it runs writes that signal"
            ));
        }
    }
    let needed: BTreeSet<SignalId> = kept
        .iter()
        .flat_map(|u| u.reads())
        .chain(kept_hosts.iter().flat_map(|h| h.reads.iter().copied()))
        .chain(scope.stubs.keys().filter_map(|n| bus.id(n)))
        .filter(|id| !written.contains(id))
        .collect();

    let mut stubs = Vec::new();
    for id in needed {
        let name = bus.name(id).to_owned();
        let spec = scope
            .stubs
            .get(&name)
            .or_else(|| defaults.get(&name))
            .cloned()
            .unwrap_or(StubSpec::Hold { value: bus.get(id) });
        kept.push(make_stub(bus, id, &spec)?);
        stubs.push(StubInfo {
            signal: name,
            kind: spec.kind_name().to_owned(),
        });
    }
    Ok(Cut {
        units: kept,
        hosts: kept_hosts,
        stubs,
        left_out,
    })
}
