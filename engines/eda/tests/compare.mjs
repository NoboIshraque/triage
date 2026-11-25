// Pixel comparison of Triage's views against KiCad's own plots (ROADMAP P1-4):
// the engine's display list drawn by Triage's WebGL2 renderer, next to kicad-cli's
// SVG export of the same file, both on the page's coordinates.
//
//   node engines/eda/tests/compare.mjs [file.kicad_pcb|file.kicad_sch ...] [--out dir]
//
// Without files it compares the KiCad demos listed in DEFAULT_CASES and the Smart
// Fan. Plot colours differ from the editor's, so both images become ink masks (any
// pixel that isn't background), and each mask is checked against the other one
// grown by RADIUS pixels:
//   coverage: the share of KiCad's ink that Triage also drew;
//   precision: the share of Triage's ink that KiCad also drew.
// Boards compare the board outline and the front silkscreen (KiCad plots copper
// with pads, holes and zones merged, which the editor draws on separate layers);
// schematics compare the whole sheet without its frame and fills. Drill holes
// are left out of KiCad's plot (the editor draws them on their own layers).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { renderDumps } from './render.mjs';
import { stagedEnv, stagedProgram } from '../stage.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const demos = path.join(root, 'engines', 'eda', 'upstream', 'demos');
const DEFAULT_CASES = [
  'pic_programmer/pic_programmer.kicad_pcb',
  'pic_programmer/pic_programmer.kicad_sch',
  'video/video.kicad_pcb',
  'video/video.kicad_sch',
  'ecc83/ecc83-pp.kicad_pcb',
  'ecc83/ecc83-pp.kicad_sch',
  'interf_u/interf_u.kicad_sch',
  'sonde xilinx/sonde xilinx.kicad_pcb',
].map((file) => path.join(demos, file));
const SMART_FAN = path.join(root, 'examples', 'smart-fan', 'electronics');
const RADIUS = 2;
/** Below these, compare.mjs fails (measured 2026-11-25: coverage 1, precision 0.98 to 1). */
const MIN_COVERAGE = 0.98;
const MIN_PRECISION = 0.95;
const WIDTH = 1600;
/** Board layers compared: Edge.Cuts and F.Silkscreen (PCB_LAYER_ID values). */
const BOARD_LAYERS = { ids: [25, 5], names: 'Edge.Cuts,F.SilkS' };

function run(program, args) {
  execFileSync(stagedProgram(program), args, {
    env: { ...process.env, ...stagedEnv() },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/** KiCad's plot of `file` as an SVG, and our dump of the same file. */
function prepare(file, out) {
  const board = file.endsWith('.kicad_pcb');
  const name = path
    .basename(file)
    .replace(/\.kicad_(pcb|sch)$/, '')
    .replaceAll(' ', '_');
  const tag = `${name}-${board ? 'pcb' : 'sch'}`;
  const prefix = path.join(out, tag);
  run('triage-eda-engine', ['--dump', file, '--out', prefix]);
  let svg;
  if (board) {
    svg = `${prefix}.kicad.svg`;
    run('kicad-cli', [
      'pcb',
      'export',
      'svg',
      '--mode-single',
      '--layers',
      BOARD_LAYERS.names,
      '--exclude-drawing-sheet',
      '--page-size-mode',
      '1',
      '--black-and-white',
      '--drill-shape-opt',
      '0',
      '--output',
      svg,
      file,
    ]);
  } else {
    const dir = path.join(out, `${tag}.kicad`);
    mkdirSync(dir, { recursive: true });
    run('kicad-cli', [
      'sch',
      'export',
      'svg',
      '--exclude-drawing-sheet',
      '--black-and-white',
      '--no-background-color',
      '--pages',
      '1',
      '--output',
      dir,
      file,
    ]);
    svg = path.join(
      dir,
      readdirSync(dir).find((f) => f.endsWith('.svg')),
    );
  }
  const info = JSON.parse(readFileSync(`${prefix}.info.json`, 'utf8')).document;
  const bbox = info.bbox;
  const pageW = (bbox.x1 ?? 0) - (bbox.x0 ?? 0);
  const pageH = (bbox.y1 ?? 0) - (bbox.y0 ?? 0);
  const height = Math.round((WIDTH * pageH) / pageW);
  const layers = board
    ? BOARD_LAYERS.ids
    : info.layers
        // Not the frame, highlights or fills: KiCad's black-and-white plot leaves
        // symbol bodies and text boxes unfilled.
        .filter(
          (l) =>
            l.visible &&
            !/^drawing sheet$|page limits|highlight|body fills|background/i.test(l.name ?? ''),
        )
        .map((l) => l.id ?? 0);
  return { file, tag, prefix, svg, board, height, layers, background: info.background };
}

const COMPARE_PAGE = `<!doctype html><html><body style="margin:0;background:#fff">
<script>
function load(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cannot load ' + src.slice(0, 40)));
    img.src = src;
  });
}
function mask(img, w, h, background, isInk) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = isInk(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) ? 1 : 0;
  return m;
}
function grow(m, w, h, r) {
  // Two passes of a box dilation (rows, then columns).
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w + r; x++) {
      if (x < w && m[y * w + x]) run = 2 * r + 1;
      if (run > 0) { const t = x - r; if (t >= 0 && t < w) a[y * w + t] = 1; run--; }
    }
    let back = 0;
    for (let x = w - 1; x >= -r; x--) {
      if (x >= 0 && m[y * w + x]) back = 2 * r + 1;
      if (back > 0) { const t = x + r; if (t >= 0 && t < w) a[y * w + t] = 1; back--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h + r; y++) {
      if (y < h && a[y * w + x]) run = 2 * r + 1;
      if (run > 0) { const t = y - r; if (t >= 0 && t < h) b[t * w + x] = 1; run--; }
    }
    let back = 0;
    for (let y = h - 1; y >= -r; y--) {
      if (y >= 0 && a[y * w + x]) back = 2 * r + 1;
      if (back > 0) { const t = y + r; if (t >= 0 && t < h) b[t * w + x] = 1; back--; }
    }
  }
  return b;
}
window.compare = async (ours, theirs, w, h, bg, r) => {
  const [a, b] = await Promise.all([load(ours), load(theirs)]);
  const near = (x, y) => Math.abs(x - y) <= 24;
  const ourInk = mask(a, w, h, 'rgb(' + bg.join(',') + ')',
    (R, G, B) => !(near(R, bg[0]) && near(G, bg[1]) && near(B, bg[2])));
  const kicadInk = mask(b, w, h, '#fff', (R, G, B) => R + G + B < 600);
  const ourGrown = grow(ourInk, w, h, r), kicadGrown = grow(kicadInk, w, h, r);
  let kicad = 0, covered = 0, mine = 0, matched = 0;
  const diff = document.createElement('canvas');
  diff.width = w; diff.height = h;
  const dctx = diff.getContext('2d');
  const img = dctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const k = kicadInk[i], o = ourInk[i];
    if (k) { kicad++; if (ourGrown[i]) covered++; }
    if (o) { mine++; if (kicadGrown[i]) matched++; }
    // Diff image: grey where both agree, red where only KiCad drew, blue where only Triage did.
    const [R, G, B] = k && !ourGrown[i] ? [220, 30, 30] : o && !kicadGrown[i] ? [30, 80, 230]
      : k || o ? [120, 120, 120] : [255, 255, 255];
    img.data.set([R, G, B, 255], i * 4);
  }
  dctx.putImageData(img, 0, 0);
  return { kicadInk: kicad, ourInk: mine, coverage: kicad ? covered / kicad : 1,
    precision: mine ? matched / mine : 1, diff: diff.toDataURL('image/png') };
};
window.ready = true;
</script></body></html>`;

export async function compare(files, out) {
  mkdirSync(out, { recursive: true });
  const cases = files.map((file) => prepare(file, out));
  const results = {};
  // Render each at its own page height (one renderDumps call per size).
  for (const c of cases) {
    const rendered = await renderDumps([c.prefix], {
      out,
      width: WIDTH,
      height: c.height,
      options: { '*': { layers: c.layers, margin: 1, frames: 0 } },
    });
    c.png = rendered[c.tag].png;
  }
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(COMPARE_PAGE);
    await page.waitForFunction(() => window.ready === true);
    for (const c of cases) {
      const bg = rgb(c.background);
      const ours = `data:image/png;base64,${readFileSync(c.png).toString('base64')}`;
      const theirs = `data:image/svg+xml;base64,${readFileSync(c.svg).toString('base64')}`;
      const result = await page.evaluate(
        ([o, t, w, h, b, r]) => window.compare(o, t, w, h, b, r),
        [ours, theirs, WIDTH, c.height, bg, RADIUS],
      );
      const diff = path.join(out, `${c.tag}.diff.png`);
      writeFileSync(diff, Buffer.from(result.diff.split(',')[1], 'base64'));
      results[c.tag] = {
        file: path.relative(root, c.file),
        coverage: Number(result.coverage.toFixed(4)),
        precision: Number(result.precision.toFixed(4)),
        kicadInk: result.kicadInk,
        ourInk: result.ourInk,
      };
      console.log(`${c.tag}: ${JSON.stringify(results[c.tag])}`);
    }
  } finally {
    await browser.close();
  }
  return results;
}

/** The document background (packed 0xRRGGBBAA, possibly negative from protobuf) as RGB. */
function rgb(packed) {
  const v = (packed ?? 0xffffffff) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255];
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out =
    outIndex >= 0 ? args.splice(outIndex, 2)[1] : path.join(root, 'engines/eda/build/compare');
  const files = args.length
    ? args.map((f) => path.resolve(f))
    : [
        ...DEFAULT_CASES,
        path.join(SMART_FAN, 'smart-fan.kicad_pcb'),
        path.join(SMART_FAN, 'smart-fan.kicad_sch'),
      ];
  const results = await compare(files, out);
  writeFileSync(path.join(out, 'compare.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failed = Object.entries(results).filter(
    ([, r]) => r.coverage < MIN_COVERAGE || r.precision < MIN_PRECISION,
  );
  for (const [tag, r] of failed) {
    console.error(`${tag}: coverage ${r.coverage}, precision ${r.precision} (see ${tag}.diff.png)`);
  }
  console.log(
    `${Object.keys(results).length - failed.length} of ${Object.keys(results).length} match KiCad's plots`,
  );
  if (failed.length) process.exitCode = 1;
}
