//! Node binding of [`triage_model`] for the app's model service (ROADMAP P0-5).
//!
//! Built as `triage_model.node` by `crates/triage-model-node/build.mjs`.
// napi-derive expands to the FFI glue Node needs, which is unsafe code.
#![allow(unsafe_code)]

use std::path::PathBuf;

use napi_derive::napi;
use triage_model::{ModelError, Project};

/// A file the manifest names, relative to the project.
#[napi(object)]
pub struct JsFile {
    /// Relative path with forward slashes.
    pub path: String,
    /// Whether the file exists.
    pub exists: bool,
}

/// One row of the project explorer.
#[napi(object)]
pub struct JsDomain {
    /// `code`, `electronics`, `mechanical` or `simulation`.
    pub id: String,
    /// `Code`, `Electronics`, `Mechanical` or `Simulation`.
    pub label: String,
    /// Whether `triage.toml` has a section for it.
    pub configured: bool,
    /// Folder relative to the project.
    pub path: String,
    /// Whether the folder exists.
    pub exists: bool,
    /// Main files (KiCad project, FreeCAD documents).
    pub files: Vec<JsFile>,
    /// Board and build system, for example.
    pub detail: Option<String>,
}

/// A loaded project.
#[napi(object)]
pub struct JsProject {
    /// The project folder.
    pub root: String,
    /// `project.name`
    pub name: String,
    /// `project.description`
    pub description: Option<String>,
    /// Manifest format.
    pub format: u32,
    /// Code, Electronics, Mechanical, Simulation.
    pub domains: Vec<JsDomain>,
}

/// Loads `<dir>/triage.toml`. Returns `null` when the folder is not a Triage
/// project, and throws with `triage.toml:line:column: message` when the
/// manifest is invalid.
///
/// # Errors
/// Invalid or unreadable manifests become JavaScript errors.
#[napi]
#[allow(clippy::needless_pass_by_value)] // napi passes strings by value
pub fn load_project(dir: String) -> napi::Result<Option<JsProject>> {
    let root = PathBuf::from(&dir);
    let project = match Project::load(&root) {
        Ok(project) => project,
        Err(ModelError::NotAProject(_)) => return Ok(None),
        Err(error) => return Err(napi::Error::from_reason(error.to_string())),
    };
    let summary = project.summary();
    Ok(Some(JsProject {
        root: dir,
        name: summary.name,
        description: summary.description,
        format: summary.format,
        domains: summary
            .domains
            .into_iter()
            .map(|d| JsDomain {
                id: d.domain.section_id().to_string(),
                label: d.domain.label().to_string(),
                configured: d.configured,
                path: d.path,
                exists: d.exists,
                files: d
                    .files
                    .into_iter()
                    .map(|(path, exists)| JsFile { path, exists })
                    .collect(),
                detail: d.detail,
            })
            .collect(),
    }))
}

/// The JSON Schema of `triage.toml`.
#[napi]
#[must_use]
pub fn manifest_schema() -> String {
    triage_model::MANIFEST_SCHEMA.to_string()
}

/// The model's version.
#[napi]
#[must_use]
pub fn version() -> String {
    triage_model::version().to_string()
}
