// Trims the staged CAD engine on Windows (ROADMAP P2-1, P8-2): FreeCAD's install copies
// the whole LibPack's bin/ beside FreeCADCmd (2.6 GB: Python with PySide6 and numpy,
// Qt's GUI and tools, VTK, LLVM and Clang …), most of which a FreeCAD without its GUI
// never loads. This keeps what the engine can load and drops the rest:
//
//   - DLLs: those FreeCADCmd.exe, FreeCAD's own libraries and modules (bin/, lib/,
//     Mod/) and Python's extension modules (bin/DLLs/) import, directly or through
//     each other, read from their PE import tables (plain and delay-load);
//   - other programs in bin/, except FreeCADCmd and Python;
//   - Python's site-packages (the engine's host uses the standard library only) and
//     its own tests; Qt's plugins, translations and resources (no GUI).
//
// Missing a DLL the engine needs fails the module and engine tests that CI runs on
// the trimmed folder.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** The DLL names a PE file (.exe, .dll, .pyd) imports, lower case. */
export function peImports(file) {
  const data = readFileSync(file);
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) return [];
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x00004550) return [];
  const sections = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = data.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const table = [];
  for (let i = 0; i < sections; i++) {
    const at = optional + optionalSize + i * 40;
    table.push({
      virtualAddress: data.readUInt32LE(at + 12),
      virtualSize: Math.max(data.readUInt32LE(at + 8), data.readUInt32LE(at + 16)),
      raw: data.readUInt32LE(at + 20),
    });
  }
  const offset = (rva) => {
    const section = table.find(
      (s) => rva >= s.virtualAddress && rva < s.virtualAddress + s.virtualSize,
    );
    return section ? rva - section.virtualAddress + section.raw : -1;
  };
  const name = (rva) => {
    const at = offset(rva);
    if (at < 0) return undefined;
    const end = data.indexOf(0, at);
    return data.toString('latin1', at, end < 0 ? at : end).toLowerCase();
  };
  const names = new Set();
  // Import directory (1): 20-byte descriptors, the DLL name's RVA at +12.
  const imports = data.readUInt32LE(directories + 8);
  for (let at = offset(imports); imports && at >= 0 && at + 20 <= data.length; at += 20) {
    const nameRva = data.readUInt32LE(at + 12);
    if (nameRva === 0) break;
    const dll = name(nameRva);
    if (dll) names.add(dll);
  }
  // Delay-load directory (13): 32-byte descriptors, the DLL name's RVA at +4.
  const delayed = data.readUInt32LE(directories + 13 * 8);
  for (let at = offset(delayed); delayed && at >= 0 && at + 32 <= data.length; at += 32) {
    const nameRva = data.readUInt32LE(at + 4);
    if (nameRva === 0) break;
    const dll = name(nameRva);
    if (dll) names.add(dll);
  }
  return [...names];
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function size(file) {
  try {
    const stat = statSync(file);
    return stat.isDirectory()
      ? walk(file).reduce((sum, f) => sum + statSync(f).size, 0)
      : stat.size;
  } catch {
    return 0;
  }
}

/** Folders and files under bin/ that a FreeCAD without its GUI never uses. */
const DROPPED = [
  path.join('Lib', 'site-packages'),
  path.join('Lib', 'test'),
  path.join('Lib', 'idlelib'),
  path.join('Lib', 'tkinter'),
  path.join('Lib', 'ensurepip'),
  'Scripts',
  'tcl',
  'include',
  'libs',
  'platforms',
  'imageformats',
  'iconengines',
  'sqldrivers',
  'styles',
  'printsupport',
  'tls',
  'translations',
  'resources',
  'qml',
  'plugins',
];

/** Programs bin/ keeps. */
const PROGRAMS = new Set(['freecadcmd.exe', 'python.exe', 'pythonw.exe']);

/**
 * Trims the staged folder in place; returns what it kept and removed. `dryRun`
 * only reports.
 */
export function trimWindowsStage(stage, { dryRun = false } = {}) {
  const bin = path.join(stage, 'bin');
  const available = new Map();
  for (const file of readdirSync(bin)) {
    if (/\.dll$/i.test(file)) available.set(file.toLowerCase(), path.join(bin, file));
  }
  const roots = [
    path.join(bin, 'FreeCADCmd.exe'),
    ...walk(path.join(stage, 'Mod')),
    ...walk(path.join(stage, 'lib')),
    ...walk(path.join(bin, 'DLLs')),
    ...readdirSync(bin)
      .filter((file) => /^(freecad.*|python3\d*)\.dll$/i.test(file))
      .map((file) => path.join(bin, file)),
  ].filter((file) => /\.(exe|dll|pyd)$/i.test(file) && existsSync(file));
  const keep = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const dll of peImports(file)) {
      const found = available.get(dll);
      if (found && !keep.has(dll)) {
        keep.add(dll);
        queue.push(found);
      }
    }
  }
  for (const file of roots) {
    if (path.dirname(file) === bin) keep.add(path.basename(file).toLowerCase());
  }

  const removed = [];
  for (const file of readdirSync(bin)) {
    const lower = file.toLowerCase();
    const full = path.join(bin, file);
    if (statSync(full).isDirectory()) continue;
    const dropDll = lower.endsWith('.dll') && !keep.has(lower);
    const dropProgram = lower.endsWith('.exe') && !PROGRAMS.has(lower);
    const dropOther = /\.(pdb|lib|exp|ilk)$/i.test(lower);
    if (dropDll || dropProgram || dropOther) removed.push(full);
  }
  for (const dir of DROPPED) {
    const full = path.join(bin, dir);
    if (existsSync(full)) removed.push(full);
  }
  for (const dir of ['include', path.join('lib', 'cmake')]) {
    const full = path.join(stage, dir);
    if (existsSync(full)) removed.push(full);
  }
  // Debug symbols and link libraries, wherever they are (Python's DLLs/ has 70 MB).
  for (const file of walk(stage)) {
    if (/\.(pdb|lib|exp|ilk)$/i.test(file) && !removed.some((r) => file.startsWith(r))) {
      removed.push(file);
    }
  }

  let bytes = 0;
  for (const file of removed) {
    bytes += size(file);
    if (!dryRun) rmSync(file, { recursive: true, force: true });
  }
  return { kept: [...keep].sort(), removed: removed.length, bytes };
}
