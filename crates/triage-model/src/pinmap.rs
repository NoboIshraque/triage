//! Pin map sync (ROADMAP P1-5, PLAN §4.5 item 1): which microcontroller pin each
//! schematic net reaches, the generated `board_pins.h`, and diagnostics for
//! firmware that uses a pin the circuit doesn't connect, or uses it wrongly.
//!
//! Input is the schematic's netlist as KiCad's engine reports it
//! (`triage.eda.v1.Netlist`); the board profile says which symbol is the board
//! and what each of its pins can do.

use std::collections::BTreeMap;
use std::fmt::Write as _;

/// A component pin, as the EDA engine reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetPin {
    /// Pin number on the symbol (`24`).
    pub number: String,
    /// Pin name on the symbol (`D9`, `SDA/A4`).
    pub name: String,
    /// Net name (`/FAN_PWM`), empty when unconnected.
    pub net: String,
}

/// A schematic component.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetComponent {
    /// `A1`
    pub reference: String,
    /// `MCU_Module:Arduino_UNO_R3`
    pub lib_id: String,
    /// `Module:Arduino_UNO_R3`
    pub footprint: String,
    /// The component's pins.
    pub pins: Vec<NetPin>,
}

/// What a board pin can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinCapabilities {
    /// Digital input and output.
    pub digital: bool,
    /// Analog input (ADC).
    pub analog: bool,
    /// Hardware PWM (`analogWrite`).
    pub pwm: bool,
}

/// One pin of a board profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoardPin {
    /// `D9`, `A0`
    pub name: &'static str,
    /// The Arduino pin number (`A0` is 14 on an Uno).
    pub number: u8,
    /// What the pin can do.
    pub capabilities: PinCapabilities,
    /// Bus role, if any: `SDA`, `SCL`, `RX`, `TX`, `MOSI`, `MISO`, `SCK`, `SS`.
    pub role: Option<&'static str>,
}

/// A supported board (ROADMAP P1-5: Arduino Uno and Nano).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoardProfile {
    /// The `firmware.board` value in `triage.toml`.
    pub id: &'static str,
    /// Display name.
    pub name: &'static str,
    /// arduino-cli's fully qualified board name.
    pub fqbn: &'static str,
    /// `PlatformIO`'s board id.
    pub platformio: &'static str,
    /// Symbol names (the part after `Library:`) that are this board.
    pub symbols: &'static [&'static str],
    /// The board's I/O pins.
    pub pins: &'static [BoardPin],
}

const fn io(name: &'static str, number: u8, pwm: bool, role: Option<&'static str>) -> BoardPin {
    BoardPin {
        name,
        number,
        capabilities: PinCapabilities {
            digital: true,
            analog: false,
            pwm,
        },
        role,
    }
}

const fn analog(
    name: &'static str,
    number: u8,
    digital: bool,
    role: Option<&'static str>,
) -> BoardPin {
    BoardPin {
        name,
        number,
        capabilities: PinCapabilities {
            digital,
            analog: true,
            pwm: false,
        },
        role,
    }
}

/// ATmega328P boards: D0–D13, A0–A5 (A4 = SDA, A5 = SCL); PWM on 3, 5, 6, 9, 10, 11.
const ATMEGA328P_PINS: [BoardPin; 20] = [
    io("D0", 0, false, Some("RX")),
    io("D1", 1, false, Some("TX")),
    io("D2", 2, false, None),
    io("D3", 3, true, None),
    io("D4", 4, false, None),
    io("D5", 5, true, None),
    io("D6", 6, true, None),
    io("D7", 7, false, None),
    io("D8", 8, false, None),
    io("D9", 9, true, None),
    io("D10", 10, true, Some("SS")),
    io("D11", 11, true, Some("MOSI")),
    io("D12", 12, false, Some("MISO")),
    io("D13", 13, false, Some("SCK")),
    analog("A0", 14, true, None),
    analog("A1", 15, true, None),
    analog("A2", 16, true, None),
    analog("A3", 17, true, None),
    analog("A4", 18, true, Some("SDA")),
    analog("A5", 19, true, Some("SCL")),
];

const NANO_PINS: [BoardPin; 22] = {
    let mut pins = [analog("A6", 20, false, None); 22];
    let mut i = 0;
    while i < 20 {
        pins[i] = ATMEGA328P_PINS[i];
        i += 1;
    }
    pins[20] = analog("A6", 20, false, None);
    pins[21] = analog("A7", 21, false, None);
    pins
};

/// The boards Triage knows (P4 adds ESP32 and Raspberry Pi Pico).
pub const BOARD_PROFILES: [BoardProfile; 2] = [
    BoardProfile {
        id: "arduino-uno",
        name: "Arduino Uno",
        fqbn: "arduino:avr:uno",
        platformio: "uno",
        symbols: &["Arduino_UNO_R3", "Arduino_UNO_R2", "Arduino_Uno_Shield"],
        pins: &ATMEGA328P_PINS,
    },
    BoardProfile {
        id: "arduino-nano",
        name: "Arduino Nano",
        fqbn: "arduino:avr:nano",
        platformio: "nanoatmega328",
        symbols: &[
            "Arduino_Nano_v3.x",
            "Arduino_Nano_v2.x",
            "Arduino_Nano_Every",
        ],
        pins: &NANO_PINS,
    },
];

/// The profile for a `firmware.board` id.
#[must_use]
pub fn board_profile(id: &str) -> Option<&'static BoardProfile> {
    BOARD_PROFILES.iter().find(|profile| profile.id == id)
}

/// A board pin and the net it reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinAssignment {
    /// The board pin.
    pub pin: BoardPin,
    /// The net (`/FAN_PWM`); empty when nothing connects to the pin.
    pub net: String,
    /// The firmware constant for the net (`FAN_PWM`), when the net has a name.
    pub constant: Option<String>,
    /// How many other component pins share the net.
    pub others: usize,
}

/// The pin map of one project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinMap {
    /// The board profile used.
    pub board: &'static BoardProfile,
    /// Reference of the board's symbol (`A1`).
    pub reference: String,
    /// Every board pin, in profile order.
    pub assignments: Vec<PinAssignment>,
}

/// Why a pin map could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinMapError {
    /// `firmware.board` names no known board.
    UnknownBoard(String),
    /// No schematic symbol is that board.
    NoBoardSymbol(&'static str),
}

impl std::fmt::Display for PinMapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownBoard(id) => write!(
                f,
                "unknown board '{id}' (known: {})",
                BOARD_PROFILES.map(|p| p.id).join(", ")
            ),
            Self::NoBoardSymbol(name) => {
                write!(
                    f,
                    "the schematic has no {name} symbol to map the firmware's pins to"
                )
            }
        }
    }
}

impl std::error::Error for PinMapError {}

/// The board pin a symbol pin name means: `SDA/A4` -> `A4`, `D0/RX` -> `D0`.
fn board_pin_name(symbol_pin: &str) -> Option<&str> {
    symbol_pin.split('/').find(|token| {
        let mut chars = token.chars();
        matches!(chars.next(), Some('D' | 'A')) && chars.as_str().parse::<u8>().is_ok()
    })
}

/// A net's firmware constant: the label text as a C identifier. Nets KiCad named
/// itself (`Net-(R2-Pad1)`, `unconnected-(…)`) and power nets get none.
#[must_use]
pub fn net_constant(net: &str) -> Option<String> {
    let name = net.rsplit('/').next().unwrap_or(net);
    if name.is_empty()
        || name.starts_with("Net-(")
        || name.starts_with("unconnected-")
        || name.starts_with('+')
        || name.eq_ignore_ascii_case("GND")
    {
        return None;
    }
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        out.push(if c.is_ascii_alphanumeric() {
            c.to_ascii_uppercase()
        } else {
            '_'
        });
    }
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    Some(out)
}

/// Builds the pin map for `board` from the schematic's components.
///
/// # Errors
/// When the board id is unknown or no component is that board.
pub fn pin_map(board: &str, components: &[NetComponent]) -> Result<PinMap, PinMapError> {
    let profile =
        board_profile(board).ok_or_else(|| PinMapError::UnknownBoard(board.to_string()))?;
    let is_board = |c: &&NetComponent| {
        let symbol = c.lib_id.rsplit(':').next().unwrap_or_default();
        let footprint = c.footprint.rsplit(':').next().unwrap_or_default();
        profile
            .symbols
            .iter()
            .any(|s| symbol == *s || footprint.starts_with(s))
    };
    let mcu = components
        .iter()
        .find(is_board)
        .ok_or(PinMapError::NoBoardSymbol(profile.symbols[0]))?;

    // Pins per net, over the whole schematic.
    let mut net_pins: BTreeMap<&str, usize> = BTreeMap::new();
    for component in components {
        for pin in &component.pins {
            if !pin.net.is_empty() {
                *net_pins.entry(pin.net.as_str()).or_default() += 1;
            }
        }
    }

    let assignments = profile
        .pins
        .iter()
        .map(|board_pin| {
            // A board pin may appear on several symbol pins (the Uno's SDA/A4 header twice).
            let net = mcu
                .pins
                .iter()
                .filter(|p| board_pin_name(&p.name) == Some(board_pin.name))
                .map(|p| p.net.as_str())
                .find(|net| !net.is_empty())
                .unwrap_or_default()
                .to_string();
            let mcu_pins_on_net = mcu
                .pins
                .iter()
                .filter(|p| !net.is_empty() && p.net == net)
                .count();
            let others = net_pins
                .get(net.as_str())
                .copied()
                .unwrap_or(0)
                .saturating_sub(mcu_pins_on_net);
            PinAssignment {
                pin: *board_pin,
                constant: if net.is_empty() {
                    None
                } else {
                    net_constant(&net)
                },
                net,
                others,
            }
        })
        .collect();

    Ok(PinMap {
        board: profile,
        reference: mcu.reference.clone(),
        assignments,
    })
}

impl PinMap {
    /// The assignment of a board pin by Arduino number.
    #[must_use]
    pub fn by_number(&self, number: u8) -> Option<&PinAssignment> {
        self.assignments.iter().find(|a| a.pin.number == number)
    }

    /// Whether the pin's net reaches anything besides the board.
    #[must_use]
    pub fn is_connected(assignment: &PinAssignment) -> bool {
        !assignment.net.is_empty() && assignment.others > 0
    }

    /// `board_pins.h`: one constant per named net on a board pin.
    #[must_use]
    pub fn header(&self, source: &str) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "// board_pins.h: generated by Triage from {source} (ROADMAP P1-5)."
        );
        let _ = writeln!(
            out,
            "// Do not edit. Rename a net in the schematic and this file follows."
        );
        let _ = writeln!(
            out,
            "// Board: {} ({}), symbol {}.",
            self.board.name, self.board.id, self.reference
        );
        let _ = writeln!(out, "#pragma once\n\n#include <stdint.h>\n");

        let named: Vec<&PinAssignment> = self
            .assignments
            .iter()
            .filter(|a| a.constant.is_some() && Self::is_connected(a))
            .collect();
        let width = named
            .iter()
            .filter_map(|a| a.constant.as_ref())
            .map(String::len)
            .max()
            .unwrap_or(0);
        let mut seen = std::collections::BTreeSet::new();
        for a in &named {
            let constant = a.constant.as_deref().unwrap_or_default();
            if !seen.insert(constant) {
                continue; // one net on two board pins: the first one names it
            }
            let mut notes = vec![a.pin.name.to_string()];
            if let Some(role) = a.pin.role {
                notes.push(role.to_string());
            }
            if a.pin.capabilities.pwm {
                notes.push("PWM".into());
            }
            if a.pin.capabilities.analog {
                notes.push("analog".into());
            }
            let _ = writeln!(
                out,
                "constexpr uint8_t {constant:<width$} = {:>2}; // {}, net {}",
                a.pin.number,
                notes.join(", "),
                a.net
            );
        }

        let unnamed: Vec<String> = self
            .assignments
            .iter()
            .filter(|a| a.constant.is_none() && Self::is_connected(a))
            .map(|a| format!("{} ({})", a.pin.name, a.net))
            .collect();
        if !unnamed.is_empty() {
            let _ = writeln!(
                out,
                "\n// Connected without a net label: {}.",
                unnamed.join(", ")
            );
        }
        let free: Vec<&str> = self
            .assignments
            .iter()
            .filter(|a| !Self::is_connected(a))
            .map(|a| a.pin.name)
            .collect();
        if !free.is_empty() {
            let _ = writeln!(out, "// Not connected: {}.", free.join(", "));
        }
        out
    }
}

/// How serious a firmware diagnostic is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// The code cannot work on this circuit.
    Error,
    /// The code probably doesn't do what was meant.
    Warning,
}

/// A problem in firmware source, with a 1-based line and 1-based columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// Error or warning.
    pub severity: Severity,
    /// Line (1-based).
    pub line: usize,
    /// First column of the pin argument (1-based).
    pub column: usize,
    /// Column after the pin argument.
    pub end_column: usize,
    /// For example `D10 is not connected to anything`.
    pub message: String,
}

/// What a pin function needs from its pin.
#[derive(Clone, Copy)]
enum Use {
    Digital,
    AnalogRead,
    AnalogWrite,
}

const PIN_CALLS: [(&str, Use); 7] = [
    ("pinMode", Use::Digital),
    ("digitalWrite", Use::Digital),
    ("digitalRead", Use::Digital),
    ("analogRead", Use::AnalogRead),
    ("analogWrite", Use::AnalogWrite),
    ("tone", Use::Digital),
    ("noTone", Use::Digital),
];

/// `name = value` constants in the source (`constexpr uint8_t X = 9;`, `#define X 9`,
/// `const int X = A0;`), resolved to pin numbers where they can be.
fn source_constants(source: &str, board: &BoardProfile) -> BTreeMap<String, u8> {
    let mut constants = BTreeMap::new();
    for line in source.lines() {
        let line = line.trim();
        let (name, value) = if let Some(rest) = line.strip_prefix("#define ") {
            let mut parts = rest.split_whitespace();
            (parts.next(), parts.next())
        } else if line.contains('=')
            && (line.starts_with("const") || line.starts_with("static const"))
        {
            let (left, right) = line.split_once('=').unwrap_or_default();
            (
                left.split_whitespace().last(),
                right.trim().trim_end_matches(';').split_whitespace().next(),
            )
        } else {
            (None, None)
        };
        if let (Some(name), Some(value)) = (name, value)
            && let Some(number) = pin_literal(value, board)
        {
            constants.insert(name.to_string(), number);
        }
    }
    constants
}

/// A pin written as a number (`9`) or as `A0`.
fn pin_literal(token: &str, board: &BoardProfile) -> Option<u8> {
    let token = token.trim();
    if let Ok(number) = token.parse::<u8>() {
        return Some(number);
    }
    board
        .pins
        .iter()
        .find(|p| p.name == token && p.name.starts_with('A'))
        .map(|p| p.number)
}

/// Diagnostics for one firmware source file against the pin map.
#[must_use]
pub fn check_firmware(source: &str, map: &PinMap) -> Vec<Diagnostic> {
    let mut constants = source_constants(source, map.board);
    for a in &map.assignments {
        if let Some(constant) = &a.constant {
            constants.entry(constant.clone()).or_insert(a.pin.number);
        }
    }

    let mut out = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let code = line.split("//").next().unwrap_or_default();
        for (function, usage) in PIN_CALLS {
            let mut from = 0;
            while let Some(found) = code[from..].find(function) {
                let start = from + found;
                from = start + function.len();
                // A whole identifier followed by '('.
                let before = code[..start].chars().next_back();
                if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                    continue;
                }
                let rest = code[from..].trim_start();
                let Some(args) = rest.strip_prefix('(') else {
                    continue;
                };
                let arg_start = code.len() - args.len();
                let arg: &str = args.split([',', ')']).next().unwrap_or_default();
                let trimmed = arg.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let lead = arg.len() - arg.trim_start().len();
                let column = arg_start + lead + 1;
                let number =
                    pin_literal(trimmed, map.board).or_else(|| constants.get(trimmed).copied());
                let Some(number) = number else { continue };
                if let Some(diagnostic) = pin_problem(map, number, usage, function) {
                    out.push(Diagnostic {
                        severity: diagnostic.0,
                        line: index + 1,
                        column,
                        end_column: column + trimmed.len(),
                        message: diagnostic.1,
                    });
                }
            }
        }
    }
    out
}

fn pin_problem(map: &PinMap, number: u8, usage: Use, function: &str) -> Option<(Severity, String)> {
    let board = map.board.name;
    let Some(assignment) = map.by_number(number) else {
        return Some((Severity::Error, format!("{board} has no pin {number}")));
    };
    let pin = assignment.pin;
    match usage {
        Use::AnalogRead if !pin.capabilities.analog => {
            return Some((
                Severity::Error,
                format!("{} is not an analog input on the {board}", pin.name),
            ));
        }
        Use::Digital | Use::AnalogWrite if !pin.capabilities.digital => {
            return Some((
                Severity::Error,
                format!(
                    "{} is analog-only on the {board}: {function}() can't use it",
                    pin.name
                ),
            ));
        }
        Use::AnalogWrite if !pin.capabilities.pwm => {
            return Some((
                Severity::Warning,
                format!(
                    "{} has no PWM on the {board}: analogWrite() only switches it fully on or off",
                    pin.name
                ),
            ));
        }
        _ => {}
    }
    if !PinMap::is_connected(assignment) {
        return Some((
            Severity::Warning,
            format!("{} is not connected to anything", pin.name),
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(number: &str, name: &str, net: &str) -> NetPin {
        NetPin {
            number: number.into(),
            name: name.into(),
            net: net.into(),
        }
    }

    fn smart_fan() -> Vec<NetComponent> {
        vec![
            NetComponent {
                reference: "A1".into(),
                lib_id: "smart_fan:Arduino_UNO_R3".into(),
                footprint: "smart_fan:Arduino_UNO_R3".into(),
                pins: vec![
                    pin("9", "A0", "/TEMP_SENSE"),
                    pin("24", "D9", "/FAN_PWM"),
                    pin("17", "D2", "/BUTTON"),
                    pin("13", "SDA/A4", "/I2C_SDA"),
                    pin("31", "SDA/A4", "/I2C_SDA"),
                    pin("25", "D10", ""),
                    pin("5", "+5V", "/+5V"),
                    pin("6", "GND", "/GND"),
                    pin("19", "D4", "Net-(A1-D4)"),
                ],
            },
            NetComponent {
                reference: "R1".into(),
                lib_id: "smart_fan:R".into(),
                pins: vec![pin("1", "~", "/TEMP_SENSE"), pin("2", "~", "/GND")],
                ..NetComponent::default()
            },
            NetComponent {
                reference: "R2".into(),
                lib_id: "smart_fan:R".into(),
                pins: vec![pin("1", "~", "/FAN_PWM"), pin("2", "~", "Net-(Q1-G)")],
                ..NetComponent::default()
            },
            NetComponent {
                reference: "SW1".into(),
                lib_id: "smart_fan:SW_Push".into(),
                pins: vec![pin("1", "1", "/BUTTON"), pin("2", "2", "/GND")],
                ..NetComponent::default()
            },
            NetComponent {
                reference: "J3".into(),
                lib_id: "smart_fan:Conn_01x04".into(),
                pins: vec![
                    pin("4", "Pin_4", "/I2C_SDA"),
                    pin("5", "Pin_5", "Net-(A1-D4)"),
                ],
                ..NetComponent::default()
            },
        ]
    }

    #[test]
    fn maps_nets_to_board_pins() {
        let map = pin_map("arduino-uno", &smart_fan()).expect("pin map");
        assert_eq!(map.reference, "A1");
        let fan = map.by_number(9).expect("D9");
        assert_eq!(fan.net, "/FAN_PWM");
        assert_eq!(fan.constant.as_deref(), Some("FAN_PWM"));
        assert_eq!(fan.others, 1);
        // SDA/A4 appears twice on the Uno symbol: one net.
        assert_eq!(map.by_number(18).expect("A4").net, "/I2C_SDA");
        assert!(!PinMap::is_connected(map.by_number(10).expect("D10")));
    }

    #[test]
    fn writes_a_header_for_named_nets() {
        let header = pin_map("arduino-uno", &smart_fan())
            .expect("pin map")
            .header("smart-fan.kicad_sch");
        assert!(
            header.contains("constexpr uint8_t FAN_PWM    =  9; // D9, PWM, net /FAN_PWM"),
            "{header}"
        );
        assert!(
            header.contains("constexpr uint8_t TEMP_SENSE = 14; // A0, analog, net /TEMP_SENSE"),
            "{header}"
        );
        assert!(
            header.contains("constexpr uint8_t I2C_SDA    = 18; // A4, SDA, analog, net /I2C_SDA"),
            "{header}"
        );
        assert!(
            header.contains("// Connected without a net label: D4 (Net-(A1-D4))."),
            "{header}"
        );
        assert!(header.contains("D10"), "{header}");
        assert!(!header.contains("GND ="));
    }

    #[test]
    fn renaming_a_net_renames_its_constant() {
        let mut components = smart_fan();
        for c in &mut components {
            for p in &mut c.pins {
                if p.net == "/FAN_PWM" {
                    p.net = "/MOTOR_SPEED".into();
                }
            }
        }
        let header = pin_map("arduino-uno", &components)
            .expect("pin map")
            .header("x");
        assert!(header.contains("MOTOR_SPEED"));
        assert!(!header.contains("FAN_PWM"));
    }

    #[test]
    fn net_constants_are_identifiers() {
        assert_eq!(net_constant("/fan-pwm"), Some("FAN_PWM".into()));
        assert_eq!(net_constant("/sub/3V3_EN"), Some("_3V3_EN".into()));
        assert_eq!(net_constant("Net-(R2-Pad1)"), None);
        assert_eq!(net_constant("/+5V"), None);
        assert_eq!(net_constant("GND"), None);
    }

    #[test]
    fn flags_unconnected_and_misused_pins() {
        let map = pin_map("arduino-uno", &smart_fan()).expect("pin map");
        let source = "#include \"board_pins.h\"\nconst int LED = 10;\nvoid loop() {\n  analogWrite(FAN_PWM, 128);\n  analogWrite(10, 3);  // the plan's example\n  analogRead(BUTTON);\n  analogWrite( 2 , 1);\n  digitalWrite(LED, HIGH);\n  int t = analogRead(A0);\n  pinMode(42, OUTPUT);\n}\n";
        let diagnostics = check_firmware(source, &map);
        let messages: Vec<(usize, usize, &str)> = diagnostics
            .iter()
            .map(|d| (d.line, d.column, d.message.as_str()))
            .collect();
        assert_eq!(
            messages,
            vec![
                (5, 15, "D10 is not connected to anything"),
                (6, 14, "D2 is not an analog input on the Arduino Uno"),
                (
                    7,
                    16,
                    "D2 has no PWM on the Arduino Uno: analogWrite() only switches it fully on or off"
                ),
                (8, 16, "D10 is not connected to anything"),
                (10, 11, "Arduino Uno has no pin 42"),
            ]
        );
        assert_eq!(diagnostics[0].end_column, 17);
        assert_eq!(diagnostics[1].severity, Severity::Error);
    }

    #[test]
    fn nano_has_analog_only_pins() {
        let components = vec![NetComponent {
            reference: "A1".into(),
            lib_id: "MCU_Module:Arduino_Nano_v3.x".into(),
            pins: vec![pin("26", "A7", "/POT"), pin("1", "D1/TX", "")],
            ..NetComponent::default()
        }];
        let map = pin_map("arduino-nano", &components).expect("pin map");
        let diagnostics = check_firmware("digitalRead(A7);\nanalogRead(A7);\n", &map);
        assert_eq!(diagnostics.len(), 2, "{diagnostics:?}");
        assert!(diagnostics[0].message.contains("analog-only"));
        assert_eq!(diagnostics[1].message, "A7 is not connected to anything");
    }

    #[test]
    fn errors_name_the_problem() {
        assert_eq!(
            pin_map("esp32", &[]).expect_err("unknown").to_string(),
            "unknown board 'esp32' (known: arduino-uno, arduino-nano)"
        );
        assert!(
            pin_map("arduino-uno", &[])
                .expect_err("no symbol")
                .to_string()
                .contains("Arduino_UNO_R3")
        );
    }
}
