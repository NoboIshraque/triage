//! What the project explorer shows (ROADMAP P0-5): the four domains, where their
//! files live and whether those exist.

use std::path::Path;

use crate::{DOMAINS, Domain, Manifest};

/// One row of the project explorer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainSummary {
    /// Which domain.
    pub domain: Domain,
    /// Whether `triage.toml` has a section for it.
    pub configured: bool,
    /// The folder, relative to the project, with forward slashes.
    pub path: String,
    /// Whether that folder exists.
    pub exists: bool,
    /// The main files the manifest names (KiCad project, FreeCAD documents),
    /// relative to the project, with whether each exists.
    pub files: Vec<(String, bool)>,
    /// A short note: board and build system, for example.
    pub detail: Option<String>,
}

/// The project as the explorer shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummary {
    /// `project.name`
    pub name: String,
    /// `project.description`
    pub description: Option<String>,
    /// Manifest format.
    pub format: u32,
    /// Code, Electronics, Mechanical, Simulation, in that order.
    pub domains: Vec<DomainSummary>,
}

/// Summarizes `manifest` for the project in `root`, checking the file system.
#[must_use]
pub fn summarize(root: &Path, manifest: &Manifest) -> ProjectSummary {
    let domains = DOMAINS
        .iter()
        .map(|&domain| {
            let (configured, path, names, detail) = describe(manifest, domain);
            let path = path.unwrap_or_else(|| domain.section().to_string());
            let files = names
                .into_iter()
                .map(|name| {
                    let relative = format!("{path}/{name}");
                    let exists = root.join(&relative).is_file();
                    (relative, exists)
                })
                .collect();
            DomainSummary {
                domain,
                configured,
                exists: root.join(&path).is_dir(),
                path,
                files,
                detail,
            }
        })
        .collect();
    ProjectSummary {
        name: manifest.project.name.clone(),
        description: manifest.project.description.clone(),
        format: manifest.project.format,
        domains,
    }
}

type Description = (bool, Option<String>, Vec<String>, Option<String>);

fn describe(manifest: &Manifest, domain: Domain) -> Description {
    match domain {
        Domain::Code => manifest
            .firmware
            .as_ref()
            .map_or((false, None, vec![], None), |s| {
                let detail = match (&s.board, s.build) {
                    (Some(board), Some(build)) => Some(format!("{board}, {}", build_name(build))),
                    (Some(board), None) => Some(board.clone()),
                    (None, Some(build)) => Some(build_name(build).to_string()),
                    (None, None) => None,
                };
                (true, s.path.clone(), vec![], detail)
            }),
        Domain::Electronics => {
            manifest
                .electronics
                .as_ref()
                .map_or((false, None, vec![], None), |s| {
                    (
                        true,
                        s.path.clone(),
                        s.kicad_project.iter().cloned().collect(),
                        None,
                    )
                })
        }
        Domain::Mechanical => manifest
            .mechanical
            .as_ref()
            .map_or((false, None, vec![], None), |s| {
                (true, s.path.clone(), s.documents.clone(), None)
            }),
        Domain::Simulation => manifest
            .simulation
            .as_ref()
            .map_or((false, None, vec![], None), |s| {
                (true, s.path.clone(), vec![], None)
            }),
    }
}

const fn build_name(build: crate::BuildSystem) -> &'static str {
    use crate::BuildSystem as B;
    match build {
        B::Platformio => "PlatformIO",
        B::ArduinoCli => "arduino-cli",
        B::Cmake => "CMake",
        B::EspIdf => "ESP-IDF",
        B::PicoSdk => "Pico SDK",
        B::Micropython => "MicroPython",
        B::Python => "Python",
    }
}
