//! A small modified-nodal-analysis solver for the analog islands of Triage's T0
//! circuit tier (ROADMAP P3-3, PLAN §4.7): resistors, sources, switches,
//! capacitors and inductors (backward Euler), and Shockley diodes (LEDs) and
//! level-1 N-channel MOSFETs solved with Newton–Raphson.
//!
//! Islands are small (a divider, a gate drive with a motor), so the matrix is
//! dense and factored with partial pivoting at every Newton iteration.
//!
//! ```
//! use triage_mna::{Circuit, Element, GROUND};
//! let mut c = Circuit::new();
//! let top = c.node();
//! let mid = c.node();
//! c.add(Element::VoltageSource { p: top, n: GROUND, volts: 5.0 });
//! c.add(Element::Resistor { a: top, b: mid, ohms: 10_000.0 });
//! c.add(Element::Resistor { a: mid, b: GROUND, ohms: 10_000.0 });
//! c.solve_dc().unwrap();
//! assert!((c.voltage(mid) - 2.5).abs() < 1e-9);
//! ```

use std::fmt;

/// A node of the circuit; [`GROUND`] is the reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Node(pub usize);

/// The reference node, at 0 V.
pub const GROUND: Node = Node(0);

/// An element's index in its circuit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ElementId(pub usize);

/// Thermal voltage at 27 °C, as SPICE uses it.
pub const VT: f64 = 0.025_852;

/// Conductance put across every junction so the matrix never goes singular.
const GMIN: f64 = 1e-12;

/// A circuit element.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Element {
    /// A resistor.
    Resistor {
        /// One end.
        a: Node,
        /// The other end.
        b: Node,
        /// Resistance in ohms.
        ohms: f64,
    },
    /// An ideal voltage source, `V(p) − V(n) = volts`.
    VoltageSource {
        /// Positive terminal.
        p: Node,
        /// Negative terminal.
        n: Node,
        /// Its voltage.
        volts: f64,
    },
    /// An ideal current source pushing `amps` from `n` through itself into `p`.
    CurrentSource {
        /// Where the current comes out.
        p: Node,
        /// Where it goes in.
        n: Node,
        /// The current.
        amps: f64,
    },
    /// A switch: `on_ohms` closed, `off_ohms` open.
    Switch {
        /// One end.
        a: Node,
        /// The other end.
        b: Node,
        /// Whether it is closed.
        closed: bool,
        /// Resistance when closed.
        on_ohms: f64,
        /// Resistance when open.
        off_ohms: f64,
    },
    /// A capacitor (open in DC; backward Euler in transients).
    Capacitor {
        /// One end.
        a: Node,
        /// The other end.
        b: Node,
        /// Capacitance in farads.
        farads: f64,
    },
    /// An inductor (short in DC; backward Euler in transients).
    Inductor {
        /// One end; current flows from `a` to `b`.
        a: Node,
        /// The other end.
        b: Node,
        /// Inductance in henries.
        henries: f64,
    },
    /// A Shockley diode (an LED with a high emission coefficient) with a series resistance.
    Diode {
        /// Anode.
        anode: Node,
        /// Cathode.
        cathode: Node,
        /// Saturation current, A.
        is: f64,
        /// Emission coefficient.
        n: f64,
        /// Series resistance, Ω (0 for none).
        rs: f64,
    },
    /// A level-1 (Shichman–Hodges) N-channel MOSFET.
    Nmos {
        /// Drain.
        d: Node,
        /// Gate.
        g: Node,
        /// Source.
        s: Node,
        /// Threshold voltage, V.
        vth: f64,
        /// Transconductance parameter `K = µCox·W/L`, A/V².
        k: f64,
        /// Channel-length modulation, 1/V.
        lambda: f64,
    },
}

/// Why a solve failed.
#[derive(Clone, Debug, PartialEq)]
pub enum SolveError {
    /// The matrix is singular (a loop of voltage sources, or a floating node).
    Singular,
    /// Newton–Raphson didn't converge.
    NoConvergence {
        /// Iterations tried.
        iterations: usize,
    },
}

impl fmt::Display for SolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolveError::Singular => write!(f, "the circuit's matrix is singular"),
            SolveError::NoConvergence { iterations } => {
                write!(
                    f,
                    "Newton–Raphson did not converge in {iterations} iterations"
                )
            }
        }
    }
}

impl std::error::Error for SolveError {}

#[derive(Clone, Copy, Debug)]
struct Slot {
    element: Element,
    /// Extra unknown (branch current) for voltage sources and inductors.
    branch: Option<usize>,
    /// Internal node between a diode's junction and its series resistance.
    inner: Option<usize>,
    /// Companion-model memory: a capacitor's voltage, an inductor's current.
    state: f64,
}

/// A circuit and its last solution.
#[derive(Clone, Debug)]
pub struct Circuit {
    nodes: usize,
    slots: Vec<Slot>,
    /// Unknowns: node voltages 1..nodes (index node−1), then branch currents.
    x: Vec<f64>,
    unknowns: usize,
    /// Newton iterations of the last solve.
    pub last_iterations: usize,
}

impl Default for Circuit {
    fn default() -> Circuit {
        Circuit::new()
    }
}

impl Circuit {
    /// An empty circuit (only ground).
    #[must_use]
    pub fn new() -> Circuit {
        Circuit {
            nodes: 1,
            slots: Vec::new(),
            x: Vec::new(),
            unknowns: 0,
            last_iterations: 0,
        }
    }

    /// A new node.
    pub fn node(&mut self) -> Node {
        self.nodes += 1;
        self.layout();
        Node(self.nodes - 1)
    }

    /// Number of nodes, ground included.
    #[must_use]
    pub fn node_count(&self) -> usize {
        self.nodes
    }

    /// Adds an element.
    pub fn add(&mut self, element: Element) -> ElementId {
        self.slots.push(Slot {
            element,
            branch: None,
            inner: None,
            state: 0.0,
        });
        self.layout();
        ElementId(self.slots.len() - 1)
    }

    /// Re-numbers the extra unknowns after a change of structure.
    fn layout(&mut self) {
        let mut next = self.nodes - 1;
        for slot in &mut self.slots {
            slot.branch = None;
            slot.inner = None;
            match slot.element {
                Element::VoltageSource { .. } | Element::Inductor { .. } => {
                    slot.branch = Some(next);
                    next += 1;
                }
                Element::Diode { rs, .. } if rs > 0.0 => {
                    slot.inner = Some(next);
                    next += 1;
                }
                _ => {}
            }
        }
        self.unknowns = next;
        self.x.resize(next, 0.0);
    }

    /// An element.
    #[must_use]
    pub fn element(&self, id: ElementId) -> Element {
        self.slots[id.0].element
    }

    /// Replaces an element's parameters (same kind and nodes: a source's value, a
    /// switch's state, a resistance).
    pub fn set(&mut self, id: ElementId, element: Element) {
        self.slots[id.0].element = element;
    }

    /// Sets a voltage source's voltage.
    pub fn set_volts(&mut self, id: ElementId, value: f64) {
        if let Element::VoltageSource { volts, .. } = &mut self.slots[id.0].element {
            *volts = value;
        }
    }

    /// Sets a resistor's resistance.
    pub fn set_ohms(&mut self, id: ElementId, value: f64) {
        if let Element::Resistor { ohms, .. } = &mut self.slots[id.0].element {
            *ohms = value;
        }
    }

    /// Opens or closes a switch.
    pub fn set_closed(&mut self, id: ElementId, value: bool) {
        if let Element::Switch { closed, .. } = &mut self.slots[id.0].element {
            *closed = value;
        }
    }

    /// A node's voltage in the last solution.
    #[must_use]
    pub fn voltage(&self, node: Node) -> f64 {
        if node.0 == 0 { 0.0 } else { self.x[node.0 - 1] }
    }

    fn v(x: &[f64], node: Node) -> f64 {
        if node.0 == 0 { 0.0 } else { x[node.0 - 1] }
    }

    /// The current through an element in the last solution, in its natural direction:
    /// `a → b` for two-terminal parts, out of `p` for voltage sources (the current the
    /// source delivers), anode → cathode for diodes, drain → source for MOSFETs.
    #[must_use]
    pub fn current(&self, id: ElementId) -> f64 {
        let slot = &self.slots[id.0];
        let x = &self.x;
        match slot.element {
            Element::Resistor { a, b, ohms } => (Self::v(x, a) - Self::v(x, b)) / ohms,
            Element::Switch {
                a,
                b,
                closed,
                on_ohms,
                off_ohms,
            } => (Self::v(x, a) - Self::v(x, b)) / if closed { on_ohms } else { off_ohms },
            Element::VoltageSource { .. } => -slot.branch.map_or(0.0, |k| x[k]),
            Element::Inductor { .. } => slot.branch.map_or(0.0, |k| x[k]),
            Element::CurrentSource { amps, .. } => amps,
            Element::Capacitor { .. } => 0.0, // not kept between steps
            Element::Diode {
                anode,
                cathode,
                is,
                n,
                ..
            } => {
                let va = slot.inner.map_or(Self::v(x, anode), |k| x[k]);
                let vd = va - Self::v(x, cathode);
                is * ((vd / (n * VT)).min(200.0).exp() - 1.0) + GMIN * vd
            }
            Element::Nmos {
                d,
                g,
                s,
                vth,
                k,
                lambda,
            } => {
                nmos(
                    Self::v(x, g) - Self::v(x, s),
                    Self::v(x, d) - Self::v(x, s),
                    vth,
                    k,
                    lambda,
                )
                .0
            }
        }
    }

    /// The DC operating point (capacitors open, inductors shorted).
    ///
    /// # Errors
    /// When the matrix is singular or Newton–Raphson doesn't converge.
    pub fn solve_dc(&mut self) -> Result<(), SolveError> {
        self.solve(None)?;
        // Initialize companion memory from the operating point.
        for i in 0..self.slots.len() {
            let state = match self.slots[i].element {
                Element::Capacitor { a, b, .. } => self.voltage(a) - self.voltage(b),
                Element::Inductor { .. } => self.current(ElementId(i)),
                _ => continue,
            };
            self.slots[i].state = state;
        }
        Ok(())
    }

    /// One backward-Euler step of `dt` seconds from the last solution.
    ///
    /// # Errors
    /// When the matrix is singular or Newton–Raphson doesn't converge.
    pub fn step(&mut self, dt: f64) -> Result<(), SolveError> {
        self.solve(Some(dt))?;
        for i in 0..self.slots.len() {
            let state = match self.slots[i].element {
                Element::Capacitor { a, b, .. } => self.voltage(a) - self.voltage(b),
                Element::Inductor { .. } => self.current(ElementId(i)),
                _ => continue,
            };
            self.slots[i].state = state;
        }
        Ok(())
    }

    #[allow(clippy::too_many_lines, clippy::many_single_char_names)]
    fn solve(&mut self, dt: Option<f64>) -> Result<(), SolveError> {
        let n = self.unknowns;
        if n == 0 {
            return Ok(());
        }
        let nonlinear = self
            .slots
            .iter()
            .any(|s| matches!(s.element, Element::Diode { .. } | Element::Nmos { .. }));
        let max_iterations = if nonlinear { 200 } else { 1 };
        let mut x = self.x.clone();
        let mut a = vec![0.0; n * n];
        let mut b = vec![0.0; n];
        for iteration in 1..=max_iterations {
            a.fill(0.0);
            b.fill(0.0);
            let mut st = Stamper {
                a: &mut a,
                b: &mut b,
                n,
            };
            for slot in &self.slots {
                match slot.element {
                    Element::Resistor { a: na, b: nb, ohms } => st.conductance(na, nb, 1.0 / ohms),
                    Element::Switch {
                        a: na,
                        b: nb,
                        closed,
                        on_ohms,
                        off_ohms,
                    } => {
                        st.conductance(na, nb, 1.0 / if closed { on_ohms } else { off_ohms });
                    }
                    Element::CurrentSource { p, n: nn, amps } => st.current(p, nn, amps),
                    Element::VoltageSource { p, n: nn, volts } => {
                        let k = slot.branch.unwrap_or(0);
                        st.branch(p, nn, k);
                        st.b[k] += volts;
                    }
                    Element::Capacitor {
                        a: na,
                        b: nb,
                        farads,
                    } => {
                        if let Some(h) = dt {
                            let g = farads / h;
                            st.conductance(na, nb, g);
                            st.current(na, nb, g * slot.state);
                        }
                    }
                    Element::Inductor {
                        a: na,
                        b: nb,
                        henries,
                    } => {
                        let k = slot.branch.unwrap_or(0);
                        st.branch(na, nb, k);
                        // V(a) − V(b) − (L/h)·i = −(L/h)·i_prev ; DC: V(a) − V(b) = 0.
                        if let Some(h) = dt {
                            st.a[k * n + k] -= henries / h;
                            st.b[k] -= henries / h * slot.state;
                        }
                    }
                    Element::Diode {
                        anode,
                        cathode,
                        is,
                        n: em,
                        rs,
                    } => {
                        let junction = slot.inner.map_or(anode, |k| Node(k + 1));
                        if let Some(k) = slot.inner {
                            st.conductance(anode, Node(k + 1), 1.0 / rs);
                        }
                        let vd = Self::v(&x, junction) - Self::v(&x, cathode);
                        let nvt = em * VT;
                        let e = (vd / nvt).min(200.0).exp();
                        let id = is * (e - 1.0);
                        let gd = is * e / nvt + GMIN;
                        st.conductance(junction, cathode, gd);
                        st.current(cathode, junction, id - gd * vd);
                    }
                    Element::Nmos {
                        d,
                        g,
                        s,
                        vth,
                        k,
                        lambda,
                    } => {
                        let vgs = Self::v(&x, g) - Self::v(&x, s);
                        let vds = Self::v(&x, d) - Self::v(&x, s);
                        let (id, gm, gds) = nmos(vgs, vds, vth, k, lambda);
                        // id ≈ id0 + gm·Δvgs + gds·Δvds, from d to s.
                        st.vccs(d, s, g, s, gm);
                        st.conductance(d, s, gds + GMIN);
                        st.current(s, d, id - gm * vgs - gds * vds);
                    }
                }
            }
            let mut solution = b.clone();
            lu_solve(&mut a, &mut solution, n)?;
            if !nonlinear {
                x = solution;
                self.last_iterations = iteration;
                break;
            }
            // Limit junction steps (SPICE's pnjlim) so exponentials don't explode.
            let mut next = solution;
            for slot in &self.slots {
                if let Element::Diode {
                    anode,
                    cathode,
                    is,
                    n: em,
                    ..
                } = slot.element
                {
                    let junction = slot.inner.map_or(anode, |k| Node(k + 1));
                    if junction.0 == 0 {
                        continue;
                    }
                    let nvt = em * VT;
                    let vcrit = nvt * (nvt / (std::f64::consts::SQRT_2 * is)).ln();
                    let old = Self::v(&x, junction) - Self::v(&x, cathode);
                    let new = Self::v(&next, junction) - Self::v(&next, cathode);
                    let limited = pnjlim(new, old, nvt, vcrit);
                    next[junction.0 - 1] += limited - new;
                }
            }
            // Damp large steps of MOSFET terminals (the square law overshoots).
            let max_step = self
                .slots
                .iter()
                .filter_map(|s| match s.element {
                    Element::Nmos { d, g, s: src, .. } => Some([d, g, src]),
                    _ => None,
                })
                .flatten()
                .filter(|node| node.0 > 0)
                .map(|node| (next[node.0 - 1] - x[node.0 - 1]).abs())
                .fold(0.0, f64::max);
            if max_step > 2.0 && iteration > 1 {
                let scale = 2.0 / max_step;
                for (p, q) in next.iter_mut().zip(&x) {
                    *p = q + (*p - q) * scale;
                }
            }
            let converged = next
                .iter()
                .zip(&x)
                .all(|(p, q)| (p - q).abs() <= 1e-9 + 1e-6 * p.abs().max(q.abs()));
            x = next;
            if converged && iteration > 1 {
                self.last_iterations = iteration;
                self.x = x;
                return Ok(());
            }
            if iteration == max_iterations {
                return Err(SolveError::NoConvergence {
                    iterations: iteration,
                });
            }
        }
        self.x = x;
        Ok(())
    }
}

/// Level-1 MOSFET drain current and its derivatives `(id, gm, gds)`.
fn nmos(vgs: f64, vds: f64, vth: f64, k: f64, lambda: f64) -> (f64, f64, f64) {
    if vds < 0.0 {
        // Reverse: swap drain and source.
        let (id, gm, gds) = nmos(vgs - vds, -vds, vth, k, lambda);
        return (-id, gm, gds + gm);
    }
    let vov = vgs - vth;
    if vov <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let clm = 1.0 + lambda * vds;
    if vds < vov {
        let id = k * (vov - vds / 2.0) * vds * clm;
        let gm = k * vds * clm;
        let gds = k * (vov - vds) * clm + k * (vov - vds / 2.0) * vds * lambda;
        (id, gm, gds)
    } else {
        let id = k / 2.0 * vov * vov * clm;
        (id, k * vov * clm, k / 2.0 * vov * vov * lambda)
    }
}

fn pnjlim(new: f64, old: f64, vt: f64, vcrit: f64) -> f64 {
    if new > vcrit && (new - old).abs() > 2.0 * vt {
        if old > 0.0 {
            let arg = 1.0 + (new - old) / vt;
            if arg > 0.0 {
                old + vt * arg.ln()
            } else {
                vcrit
            }
        } else {
            vt * (new / vt).ln()
        }
    } else {
        new
    }
}

struct Stamper<'a> {
    a: &'a mut [f64],
    b: &'a mut [f64],
    n: usize,
}

impl Stamper<'_> {
    fn at(&mut self, row: Node, col: Node, value: f64) {
        if row.0 > 0 && col.0 > 0 {
            self.a[(row.0 - 1) * self.n + (col.0 - 1)] += value;
        }
    }

    fn conductance(&mut self, a: Node, b: Node, g: f64) {
        self.at(a, a, g);
        self.at(b, b, g);
        self.at(a, b, -g);
        self.at(b, a, -g);
    }

    /// A current `amps` flowing into node `p` (and out of `n`).
    fn current(&mut self, p: Node, n: Node, amps: f64) {
        if p.0 > 0 {
            self.b[p.0 - 1] += amps;
        }
        if n.0 > 0 {
            self.b[n.0 - 1] -= amps;
        }
    }

    /// A branch-current unknown `k` between `p` and `n` (`V(p) − V(n)` in row k).
    fn branch(&mut self, p: Node, n: Node, k: usize) {
        let size = self.n;
        if p.0 > 0 {
            self.a[(p.0 - 1) * size + k] += 1.0;
            self.a[k * size + (p.0 - 1)] += 1.0;
        }
        if n.0 > 0 {
            self.a[(n.0 - 1) * size + k] -= 1.0;
            self.a[k * size + (n.0 - 1)] -= 1.0;
        }
    }

    /// A current `gm·(V(cp) − V(cn))` from `p` to `n`.
    fn vccs(&mut self, p: Node, n: Node, cp: Node, cn: Node, gm: f64) {
        self.at(p, cp, gm);
        self.at(p, cn, -gm);
        self.at(n, cp, -gm);
        self.at(n, cn, gm);
    }
}

/// Solves `a·x = b` in place (b becomes x), LU with partial pivoting.
#[allow(clippy::many_single_char_names)]
fn lu_solve(a: &mut [f64], b: &mut [f64], n: usize) -> Result<(), SolveError> {
    for col in 0..n {
        let mut pivot = col;
        let mut best = a[col * n + col].abs();
        for row in col + 1..n {
            let v = a[row * n + col].abs();
            if v > best {
                best = v;
                pivot = row;
            }
        }
        if best < 1e-300 {
            return Err(SolveError::Singular);
        }
        if pivot != col {
            for k in 0..n {
                a.swap(col * n + k, pivot * n + k);
            }
            b.swap(col, pivot);
        }
        let d = a[col * n + col];
        for row in col + 1..n {
            let f = a[row * n + col] / d;
            if f == 0.0 {
                continue;
            }
            for k in col..n {
                a[row * n + k] -= f * a[col * n + k];
            }
            b[row] -= f * b[col];
        }
    }
    for row in (0..n).rev() {
        let mut sum = b[row];
        for k in row + 1..n {
            sum -= a[row * n + k] * b[k];
        }
        b[row] = sum / a[row * n + row];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn thermistor_divider() {
        // +5 V — NTC (6.505 kΩ at 35 °C) — A0 — 10 kΩ — GND.
        let mut c = Circuit::new();
        let vcc = c.node();
        let a0 = c.node();
        c.add(Element::VoltageSource {
            p: vcc,
            n: GROUND,
            volts: 5.0,
        });
        let ntc = c.add(Element::Resistor {
            a: vcc,
            b: a0,
            ohms: 10_000.0,
        });
        c.add(Element::Resistor {
            a: a0,
            b: GROUND,
            ohms: 10_000.0,
        });
        c.solve_dc().unwrap();
        assert!(close(c.voltage(a0), 2.5, 1e-9));
        c.set_ohms(ntc, 6_505.0);
        c.solve_dc().unwrap();
        assert!(close(c.voltage(a0), 5.0 * 10_000.0 / 16_505.0, 1e-9));
    }

    #[test]
    fn led_current_matches_its_forward_drop() {
        // 5 V — 220 Ω — red LED — GND: about (5 − 1.9) / 220 ≈ 14 mA.
        let mut c = Circuit::new();
        let pin = c.node();
        let anode = c.node();
        c.add(Element::VoltageSource {
            p: pin,
            n: GROUND,
            volts: 5.0,
        });
        c.add(Element::Resistor {
            a: pin,
            b: anode,
            ohms: 220.0,
        });
        let led = c.add(Element::Diode {
            anode,
            cathode: GROUND,
            is: 1e-18,
            n: 2.0,
            rs: 5.0,
        });
        c.solve_dc().unwrap();
        let i = c.current(led);
        let vf = c.voltage(anode);
        assert!(
            close(i, (5.0 - vf) / 220.0, 1e-6),
            "KCL: {i} vs {}",
            (5.0 - vf) / 220.0
        );
        assert!(vf > 1.8 && vf < 2.1, "forward drop {vf}");
        assert!(i > 0.013 && i < 0.015, "current {i}");
        // Off: no current.
        c.set_volts(ElementId(0), 0.0);
        c.solve_dc().unwrap();
        assert!(c.current(led).abs() < 1e-9);
    }

    #[test]
    fn rc_charges_with_its_time_constant() {
        let mut c = Circuit::new();
        let top = c.node();
        let cap = c.node();
        c.add(Element::VoltageSource {
            p: top,
            n: GROUND,
            volts: 0.0,
        });
        c.add(Element::Resistor {
            a: top,
            b: cap,
            ohms: 1_000.0,
        });
        c.add(Element::Capacitor {
            a: cap,
            b: GROUND,
            farads: 1e-6,
        });
        c.solve_dc().unwrap();
        c.set_volts(ElementId(0), 1.0);
        // τ = 1 ms; 1000 steps of 1 µs.
        for _ in 0..1000 {
            c.step(1e-6).unwrap();
        }
        assert!(close(c.voltage(cap), 1.0 - (-1.0f64).exp(), 2e-3));
    }

    #[test]
    fn rl_current_rises_and_the_flyback_diode_catches_it() {
        // 12 V — motor coil (20 Ω, 2 mH) — switch to GND; diode across the coil.
        let mut c = Circuit::new();
        let vcc = c.node();
        let mid = c.node();
        let low = c.node();
        c.add(Element::VoltageSource {
            p: vcc,
            n: GROUND,
            volts: 12.0,
        });
        c.add(Element::Resistor {
            a: vcc,
            b: mid,
            ohms: 20.0,
        });
        let coil = c.add(Element::Inductor {
            a: mid,
            b: low,
            henries: 2e-3,
        });
        c.add(Element::Diode {
            anode: low,
            cathode: vcc,
            is: 7e-9,
            n: 1.8,
            rs: 0.034,
        });
        let sw = c.add(Element::Switch {
            a: low,
            b: GROUND,
            closed: false,
            on_ohms: 0.02,
            off_ohms: 1e9,
        });
        c.solve_dc().unwrap();
        c.set_closed(sw, true);
        // τ = L/R = 0.1 ms: after 1 ms the current is 12 / 20.02 A.
        for _ in 0..1000 {
            c.step(1e-6).unwrap();
        }
        let on = c.current(coil);
        assert!(close(on, 12.0 / 20.02, 1e-3), "{on}");
        // Opening the switch: the diode carries the coil's current; the node clamps at
        // one diode drop above 12 V instead of spiking.
        c.set_closed(sw, false);
        c.step(1e-6).unwrap();
        assert!(
            c.voltage(low) > 12.3 && c.voltage(low) < 13.2,
            "{}",
            c.voltage(low)
        );
        assert!(close(c.current(coil), on, 0.05));
        for _ in 0..2000 {
            c.step(1e-6).unwrap();
        }
        assert!(c.current(coil).abs() < 1e-3);
    }

    #[test]
    fn logic_level_mosfet_switches_a_load() {
        // IRLZ44N-like: Vth 1.5 V, K 13 A/V² (about 22 mΩ at 5 V gate).
        let mut c = Circuit::new();
        let vcc = c.node();
        let drain = c.node();
        let gate = c.node();
        c.add(Element::VoltageSource {
            p: vcc,
            n: GROUND,
            volts: 12.0,
        });
        let gate_drive = c.add(Element::VoltageSource {
            p: gate,
            n: GROUND,
            volts: 0.0,
        });
        let load = c.add(Element::Resistor {
            a: vcc,
            b: drain,
            ohms: 24.0,
        });
        let q = c.add(Element::Nmos {
            d: drain,
            g: gate,
            s: GROUND,
            vth: 1.5,
            k: 13.0,
            lambda: 0.01,
        });
        c.solve_dc().unwrap();
        assert!(c.current(load).abs() < 1e-9);
        c.set_volts(gate_drive, 5.0);
        c.solve_dc().unwrap();
        assert!(close(c.current(q), 0.5, 0.001), "{}", c.current(q));
        assert!(c.voltage(drain) < 0.02);
    }
}
