//! `triage.toml`, format 0. Mirrors `schema/triage.schema.json`.

use serde::Deserialize;

use crate::ModelError;

/// The manifest format version this crate reads.
pub const FORMAT: u32 = 0;

/// A parsed and validated `triage.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// `[project]`
    pub project: ProjectSection,
    /// `[firmware]`: the Code domain.
    pub firmware: Option<FirmwareSection>,
    /// `[electronics]`
    pub electronics: Option<ElectronicsSection>,
    /// `[mechanical]`
    pub mechanical: Option<MechanicalSection>,
    /// `[simulation]`
    pub simulation: Option<SimulationSection>,
}

/// `[project]`
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSection {
    /// Shown in the project explorer.
    pub name: String,
    /// Manifest format version; must be [`FORMAT`].
    pub format: u32,
    /// Optional one-line description.
    pub description: Option<String>,
}

/// How firmware is built or run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildSystem {
    /// `PlatformIO` Core.
    Platformio,
    /// `arduino-cli`.
    ArduinoCli,
    /// `CMake`.
    Cmake,
    /// Espressif's ESP-IDF.
    EspIdf,
    /// Raspberry Pi Pico SDK.
    PicoSdk,
    /// `MicroPython` scripts.
    Micropython,
    /// Python scripts (Raspberry Pi 4/5).
    Python,
}

/// `[firmware]`
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirmwareSection {
    /// Folder, relative to the project. Default `firmware`.
    pub path: Option<String>,
    /// Board profile id, e.g. `arduino-uno`.
    pub board: Option<String>,
    /// Build system.
    pub build: Option<BuildSystem>,
}

/// `[electronics]`
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ElectronicsSection {
    /// Folder, relative to the project. Default `electronics`.
    pub path: Option<String>,
    /// The `.kicad_pro` file, relative to `path`.
    pub kicad_project: Option<String>,
}

/// `[mechanical]`
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MechanicalSection {
    /// Folder, relative to the project. Default `mechanical`.
    pub path: Option<String>,
    /// `.FCStd` documents, relative to `path`.
    #[serde(default)]
    pub documents: Vec<String>,
}

/// `[simulation]`
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulationSection {
    /// Folder, relative to the project. Default `simulation`.
    pub path: Option<String>,
}

impl Manifest {
    /// Parses and validates manifest text.
    ///
    /// # Errors
    /// [`ModelError::Invalid`] with the line and column of the problem when the
    /// TOML can't be parsed or doesn't follow format 0.
    pub fn parse(text: &str) -> Result<Self, ModelError> {
        let manifest: Self = toml::from_str(text).map_err(|error| {
            let (line, column) = error
                .span()
                .map_or((None, None), |span| line_column(text, span.start));
            ModelError::Invalid {
                line,
                column,
                message: error.message().to_string(),
            }
        })?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), ModelError> {
        let invalid = |message: String| ModelError::Invalid {
            line: None,
            column: None,
            message,
        };
        if self.project.format != FORMAT {
            return Err(invalid(format!(
                "project.format is {}, but this Triage reads format {FORMAT}; a newer Triage may have made this project",
                self.project.format
            )));
        }
        if self.project.name.trim().is_empty() {
            return Err(invalid("project.name must not be empty".into()));
        }
        let mut paths: Vec<(&str, &str)> = Vec::new();
        if let Some(section) = &self.firmware {
            paths.extend(section.path.as_deref().map(|p| ("firmware.path", p)));
            if section
                .board
                .as_deref()
                .is_some_and(|b| b.trim().is_empty())
            {
                return Err(invalid("firmware.board must not be empty".into()));
            }
        }
        if let Some(section) = &self.electronics {
            paths.extend(section.path.as_deref().map(|p| ("electronics.path", p)));
            if let Some(project) = section.kicad_project.as_deref() {
                paths.push(("electronics.kicad_project", project));
                if !project.ends_with(".kicad_pro") {
                    return Err(invalid(format!(
                        "electronics.kicad_project must name a .kicad_pro file, not '{project}'"
                    )));
                }
            }
        }
        if let Some(section) = &self.mechanical {
            paths.extend(section.path.as_deref().map(|p| ("mechanical.path", p)));
            for document in &section.documents {
                paths.push(("mechanical.documents", document));
                if !document.ends_with(".FCStd") {
                    return Err(invalid(format!(
                        "mechanical.documents must list .FCStd files, not '{document}'"
                    )));
                }
            }
        }
        if let Some(section) = &self.simulation {
            paths.extend(section.path.as_deref().map(|p| ("simulation.path", p)));
        }
        for (key, path) in paths {
            check_relative_path(path).map_err(|why| invalid(format!("{key} '{path}' {why}")))?;
        }
        Ok(())
    }
}

/// Paths in the manifest stay inside the project and look the same on every OS.
fn check_relative_path(path: &str) -> Result<(), &'static str> {
    let bytes = path.as_bytes();
    if path.is_empty() {
        Err("must not be empty")
    } else if path.contains('\\') {
        Err("must use forward slashes")
    } else if path.starts_with('/') || (bytes.len() >= 2 && bytes[1] == b':') {
        Err("must be relative to the project folder")
    } else if path.split('/').any(|part| part == "..") {
        Err("must not leave the project folder ('..')")
    } else {
        Ok(())
    }
}

/// 1-based line and column of a byte offset.
fn line_column(text: &str, offset: usize) -> (Option<usize>, Option<usize>) {
    let before = &text[..offset.min(text.len())];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rfind('\n')
        .map_or(before.chars().count(), |newline| {
            before[newline + 1..].chars().count()
        })
        + 1;
    (Some(line), Some(column))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = "[project]\nname = \"Blink\"\nformat = 0\n";

    fn invalid_message(text: &str) -> String {
        match Manifest::parse(text) {
            Err(ModelError::Invalid { message, .. }) => message,
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn minimal_manifest_has_no_domains() {
        let manifest = Manifest::parse(MINIMAL).expect("valid");
        assert_eq!(manifest.project.name, "Blink");
        assert!(manifest.firmware.is_none() && manifest.electronics.is_none());
    }

    #[test]
    fn full_manifest() {
        let manifest = Manifest::parse(
            r#"
            [project]
            name = "Smart Fan"
            format = 0
            [firmware]
            board = "arduino-uno"
            build = "arduino-cli"
            [electronics]
            kicad_project = "smart-fan.kicad_pro"
            [mechanical]
            path = "cad"
            documents = ["enclosure.FCStd"]
            [simulation]
            "#,
        )
        .expect("valid");
        let firmware = manifest.firmware.expect("firmware");
        assert_eq!(firmware.build, Some(BuildSystem::ArduinoCli));
        assert_eq!(
            manifest.mechanical.expect("mechanical").documents,
            ["enclosure.FCStd"]
        );
        assert!(manifest.simulation.is_some());
    }

    #[test]
    fn syntax_errors_carry_line_and_column() {
        let error = Manifest::parse("[project]\nname = \"x\"\nformat = = 0\n").unwrap_err();
        let ModelError::Invalid { line, column, .. } = error else {
            panic!("expected Invalid");
        };
        assert_eq!(line, Some(3));
        assert!(column.is_some());
    }

    #[test]
    fn rejects_unknown_keys_and_build_systems() {
        assert!(invalid_message(&format!("{MINIMAL}colour = \"red\"\n")).contains("colour"));
        assert!(
            invalid_message(&format!("{MINIMAL}[firmware]\nbuild = \"make\"\n")).contains("make")
        );
    }

    #[test]
    fn rejects_other_formats_and_empty_names() {
        assert!(invalid_message("[project]\nname = \"x\"\nformat = 1\n").contains("format 0"));
        assert!(invalid_message("[project]\nname = \" \"\nformat = 0\n").contains("name"));
        assert!(invalid_message("[project]\nformat = 0\n").contains("name"));
    }

    #[test]
    fn paths_stay_inside_the_project() {
        for (path, why) in [
            ("../outside", ".."),
            ("/abs", "relative"),
            ("C:/abs", "relative"),
            ("a\\b", "forward slashes"),
            ("a/../../b", ".."),
        ] {
            let text = format!("{MINIMAL}[firmware]\npath = '{path}'\n");
            let message = invalid_message(&text);
            assert!(message.contains(why), "{path}: {message}");
        }
        assert!(Manifest::parse(&format!("{MINIMAL}[firmware]\npath = 'src/fw..v2'\n")).is_ok());
    }

    #[test]
    fn checks_kicad_and_freecad_file_types() {
        assert!(
            invalid_message(&format!(
                "{MINIMAL}[electronics]\nkicad_project = 'a.sch'\n"
            ))
            .contains(".kicad_pro")
        );
        assert!(
            invalid_message(&format!("{MINIMAL}[mechanical]\ndocuments = ['a.step']\n"))
                .contains(".FCStd")
        );
    }
}
