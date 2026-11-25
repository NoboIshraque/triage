//! Triage's project model (ROADMAP P0-5).
//!
//! A Triage project is a folder with a `triage.toml` manifest (format 0, schema in
//! `schema/triage.schema.json`) that names the project and where each domain's
//! files live: code, electronics (`KiCad`), mechanical (`FreeCAD`) and simulation.
//! This crate loads and validates the manifest and summarizes the four domains for
//! the project explorer. [`pinmap`] maps the schematic's nets to the firmware's
//! pins and writes `board_pins.h` (P1-5).

mod manifest;
pub mod pinmap;
mod summary;

pub use manifest::{
    BuildSystem, ElectronicsSection, FORMAT, FirmwareSection, Manifest, MechanicalSection,
    ProjectSection, SimulationSection,
};
pub use summary::{DomainSummary, ProjectSummary, summarize};

use std::fmt;
use std::path::{Path, PathBuf};

/// File name of the manifest at the root of every Triage project.
pub const PROJECT_FILE_NAME: &str = "triage.toml";

/// The JSON Schema of `triage.toml`, for editors and other tools.
pub const MANIFEST_SCHEMA: &str = include_str!("../schema/triage.schema.json");

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

    /// A stable id for the domain: `code`, `electronics`, `mechanical`, `simulation`.
    #[must_use]
    pub const fn section_id(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Electronics => "electronics",
            Self::Mechanical => "mechanical",
            Self::Simulation => "simulation",
        }
    }

    /// The manifest section that configures the domain.
    #[must_use]
    pub const fn section(self) -> &'static str {
        match self {
            Self::Code => "firmware",
            Self::Electronics => "electronics",
            Self::Mechanical => "mechanical",
            Self::Simulation => "simulation",
        }
    }
}

/// Why a project could not be loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    /// The folder has no `triage.toml`.
    NotAProject(PathBuf),
    /// The manifest could not be read.
    Io {
        /// The file.
        path: PathBuf,
        /// The operating system's message.
        message: String,
    },
    /// The manifest is not valid TOML, or doesn't match format 0.
    Invalid {
        /// 1-based line, when known.
        line: Option<usize>,
        /// 1-based column, when known.
        column: Option<usize>,
        /// What is wrong.
        message: String,
    },
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAProject(dir) => {
                write!(f, "{} has no {PROJECT_FILE_NAME}", dir.display())
            }
            Self::Io { path, message } => write!(f, "cannot read {}: {message}", path.display()),
            Self::Invalid {
                line: Some(line),
                column: Some(column),
                message,
            } => write!(f, "{PROJECT_FILE_NAME}:{line}:{column}: {message}"),
            Self::Invalid { message, .. } => write!(f, "{PROJECT_FILE_NAME}: {message}"),
        }
    }
}

impl std::error::Error for ModelError {}

/// A loaded project: its folder and its validated manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// The project folder (the one holding `triage.toml`).
    pub root: PathBuf,
    /// The manifest.
    pub manifest: Manifest,
}

impl Project {
    /// Loads `<dir>/triage.toml` and validates it.
    ///
    /// # Errors
    /// [`ModelError::NotAProject`] when there is no manifest, [`ModelError::Io`]
    /// when it can't be read, [`ModelError::Invalid`] when it isn't format 0.
    pub fn load(dir: &Path) -> Result<Self, ModelError> {
        let file = dir.join(PROJECT_FILE_NAME);
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ModelError::NotAProject(dir.to_path_buf()));
            }
            Err(error) => {
                return Err(ModelError::Io {
                    path: file,
                    message: error.to_string(),
                });
            }
        };
        Ok(Self {
            root: dir.to_path_buf(),
            manifest: Manifest::parse(&text)?,
        })
    }

    /// What the project explorer shows: the four domains and whether their
    /// folders exist.
    #[must_use]
    pub fn summary(&self) -> ProjectSummary {
        summarize(&self.root, &self.manifest)
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
    fn domains_have_labels_and_sections_in_display_order() {
        let labels: Vec<_> = DOMAINS.iter().map(|d| d.label()).collect();
        assert_eq!(labels, ["Code", "Electronics", "Mechanical", "Simulation"]);
        let sections: Vec<_> = DOMAINS.iter().map(|d| d.section()).collect();
        assert_eq!(
            sections,
            ["firmware", "electronics", "mechanical", "simulation"]
        );
    }

    #[test]
    fn the_schema_is_embedded() {
        assert!(
            MANIFEST_SCHEMA.contains("\"triage.toml\"") || MANIFEST_SCHEMA.contains("triage.toml")
        );
    }
}
