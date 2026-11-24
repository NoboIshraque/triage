//! Triage's project model.
//!
//! ROADMAP P0-5 fills this crate in: loading and validating `triage.toml`, the
//! link graph between code, electronics, mechanics and simulation, and the napi
//! binding the model service uses. For now it holds the names other crates and
//! the app agree on.

/// File name of the manifest at the root of every Triage project.
pub const PROJECT_FILE_NAME: &str = "triage.toml";

/// The project domains shown in the project explorer, in display order.
pub const DOMAINS: [Domain; 4] = [
    Domain::Code,
    Domain::Electronics,
    Domain::Mechanical,
    Domain::Simulation,
];

/// One of the four parts of a Triage project (PLAN §4.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Domain {
    /// Firmware and scripts.
    Code,
    /// Schematic and board (KiCad files).
    Electronics,
    /// Enclosures and mechanisms (FreeCAD files).
    Mechanical,
    /// Scopes, scenarios and recordings.
    Simulation,
}

impl Domain {
    /// The label the project explorer shows.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Code => "Code",
            Self::Electronics => "Electronics",
            Self::Mechanical => "Mechanical",
            Self::Simulation => "Simulation",
        }
    }
}

/// This crate's version, for diagnostics.
#[must_use]
pub const fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_file_is_toml() {
        assert_eq!(PROJECT_FILE_NAME, "triage.toml");
    }

    #[test]
    fn domains_have_distinct_labels_in_display_order() {
        let labels: Vec<_> = DOMAINS.iter().map(|d| d.label()).collect();
        assert_eq!(labels, ["Code", "Electronics", "Mechanical", "Simulation"]);
    }

    #[test]
    fn version_is_semver_like() {
        assert_eq!(version().split('.').count(), 3);
    }
}
