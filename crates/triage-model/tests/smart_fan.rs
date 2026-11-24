//! The example project the app's smoke test opens (examples/smart-fan).

use std::path::PathBuf;

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
