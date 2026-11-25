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
    /// `firmware.board`, the board profile id (`arduino-uno`).
    pub board: Option<String>,
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
    let board = project
        .manifest
        .firmware
        .as_ref()
        .and_then(|f| f.board.clone());
    Ok(Some(JsProject {
        board,
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

/// A component pin from the EDA engine's netlist (`triage.eda.v1.Pin`).
#[napi(object)]
pub struct JsNetPin {
    /// Pin number on the symbol.
    pub number: String,
    /// Pin name on the symbol.
    pub name: String,
    /// Net name; empty when unconnected.
    pub net: String,
}

/// A schematic component from the EDA engine's netlist (`triage.eda.v1.Component`).
#[napi(object)]
pub struct JsNetComponent {
    /// Reference designator.
    pub reference: String,
    /// `Library:Symbol`
    pub lib_id: String,
    /// `Library:Footprint`
    pub footprint: String,
    /// The component's pins.
    pub pins: Vec<JsNetPin>,
}

/// A firmware source file to check.
#[napi(object)]
pub struct JsSource {
    /// Path, as the caller wants it reported back.
    pub path: String,
    /// The file's text.
    pub text: String,
}

/// One board pin and its net.
#[napi(object)]
#[allow(clippy::struct_excessive_bools)] // a plain record for JavaScript
pub struct JsPinAssignment {
    /// `D9`
    pub pin: String,
    /// Arduino pin number.
    pub number: u32,
    /// Net name; empty when unconnected.
    pub net: String,
    /// Firmware constant for the net, if it has a name.
    pub constant: Option<String>,
    /// Whether the net reaches another component.
    pub connected: bool,
    /// PWM, analog, digital, bus role.
    pub pwm: bool,
    /// Analog input.
    pub analog: bool,
    /// Digital I/O.
    pub digital: bool,
    /// `SDA`, `SCL`, `RX`, ...
    pub role: Option<String>,
}

/// A firmware diagnostic.
#[napi(object)]
pub struct JsDiagnostic {
    /// The source's `path`.
    pub path: String,
    /// `error` or `warning`.
    pub severity: String,
    /// 1-based line.
    pub line: u32,
    /// 1-based first column.
    pub column: u32,
    /// Column after the range.
    pub end_column: u32,
    /// The message.
    pub message: String,
}

/// The pin map of a project (ROADMAP P1-5).
#[napi(object)]
pub struct JsPinMap {
    /// The board profile id.
    pub board: String,
    /// The board's display name.
    pub board_name: String,
    /// arduino-cli's board name.
    pub fqbn: String,
    /// `PlatformIO`'s board id.
    pub platformio: String,
    /// Reference of the board symbol.
    pub reference: String,
    /// `board_pins.h`
    pub header: String,
    /// Every board pin.
    pub pins: Vec<JsPinAssignment>,
    /// Problems in the firmware sources.
    pub diagnostics: Vec<JsDiagnostic>,
}

/// Maps the schematic's nets to the board's pins, writes `board_pins.h` and checks
/// the firmware sources.
///
/// # Errors
/// Throws when the board is unknown or not in the schematic.
#[napi]
#[allow(clippy::needless_pass_by_value)] // napi passes arguments by value
pub fn pin_map(
    board: String,
    schematic: String,
    components: Vec<JsNetComponent>,
    sources: Vec<JsSource>,
) -> napi::Result<JsPinMap> {
    use triage_model::pinmap::{self, NetComponent, NetPin, PinMap, Severity};
    let components: Vec<NetComponent> = components
        .into_iter()
        .map(|c| NetComponent {
            reference: c.reference,
            lib_id: c.lib_id,
            footprint: c.footprint,
            pins: c
                .pins
                .into_iter()
                .map(|p| NetPin {
                    number: p.number,
                    name: p.name,
                    net: p.net,
                })
                .collect(),
        })
        .collect();
    let map = pinmap::pin_map(&board, &components)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let to_u32 = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let diagnostics = sources
        .iter()
        .flat_map(|source| {
            pinmap::check_firmware(&source.text, &map)
                .into_iter()
                .map(|d| JsDiagnostic {
                    path: source.path.clone(),
                    severity: if d.severity == Severity::Error {
                        "error"
                    } else {
                        "warning"
                    }
                    .into(),
                    line: to_u32(d.line),
                    column: to_u32(d.column),
                    end_column: to_u32(d.end_column),
                    message: d.message,
                })
        })
        .collect();
    Ok(JsPinMap {
        board: map.board.id.into(),
        board_name: map.board.name.into(),
        fqbn: map.board.fqbn.into(),
        platformio: map.board.platformio.into(),
        reference: map.reference.clone(),
        header: map.header(&schematic),
        pins: map
            .assignments
            .iter()
            .map(|a| JsPinAssignment {
                pin: a.pin.name.into(),
                number: u32::from(a.pin.number),
                net: a.net.clone(),
                constant: a.constant.clone(),
                connected: PinMap::is_connected(a),
                pwm: a.pin.capabilities.pwm,
                analog: a.pin.capabilities.analog,
                digital: a.pin.capabilities.digital,
                role: a.pin.role.map(str::to_string),
            })
            .collect(),
        diagnostics,
    })
}
