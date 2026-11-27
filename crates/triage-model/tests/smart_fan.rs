//! The example project the app's smoke test opens (examples/smart-fan).

use std::path::PathBuf;

use triage_model::pinmap::{NetComponent, NetPin, pin_map};
use triage_model::{Domain, ModelError, Project};

fn example(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name)
}

#[test]
fn smart_fan_shows_four_domains() {
    let project = Project::load(&example("smart-fan")).expect("loads");
    let summary = project.summary();
    assert_eq!(summary.name, "Smart Fan");
    let rows: Vec<_> = summary
        .domains
        .iter()
        .map(|d| (d.domain, d.configured, d.path.as_str(), d.exists))
        .collect();
    assert_eq!(
        rows,
        [
            (Domain::Code, true, "firmware", true),
            (Domain::Electronics, true, "electronics", true),
            (Domain::Mechanical, true, "mechanical", true),
            (Domain::Simulation, true, "simulation", true),
        ]
    );
    let code = &summary.domains[0];
    assert_eq!(code.detail.as_deref(), Some("arduino-uno, arduino-cli"));
}

#[test]
fn a_folder_without_a_manifest_is_not_a_project() {
    let error = Project::load(&example("does-not-exist")).unwrap_err();
    assert!(matches!(error, ModelError::NotAProject(_)));
    assert!(error.to_string().contains("triage.toml"));
}

/// The committed `firmware/generated/board_pins.h` is what Triage writes from the
/// schematic's netlist (`.triage/links.json`, written by the window from KiCad's
/// engine, ROADMAP P1-5), so the firmware's pin names and the schematic agree.
#[test]
fn smart_fan_board_pins_match_the_schematic() {
    let root = example("smart-fan");
    let text = |path: &str| std::fs::read_to_string(root.join(path)).expect(path);
    let links: serde_json::Value = serde_json::from_str(&text(".triage/links.json")).expect("JSON");
    let field = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or_default().to_string();
    let components: Vec<NetComponent> = links["components"]
        .as_array()
        .expect("components")
        .iter()
        .map(|c| NetComponent {
            reference: field(c, "reference"),
            lib_id: field(c, "symbol"),
            footprint: field(c, "footprint"),
            pins: c["pins"]
                .as_array()
                .expect("pins")
                .iter()
                .map(|p| NetPin {
                    number: field(p, "number"),
                    name: field(p, "name"),
                    net: field(p, "net"),
                })
                .collect(),
        })
        .collect();
    let header = pin_map("arduino-uno", &components)
        .expect("pin map")
        .header("electronics/smart-fan.kicad_sch");
    let committed = text("firmware/generated/board_pins.h").replace("\r\n", "\n");
    if committed != header {
        println!("{header}");
    }
    assert_eq!(
        committed, header,
        "board_pins.h differs from the schematic's pin map"
    );
}
