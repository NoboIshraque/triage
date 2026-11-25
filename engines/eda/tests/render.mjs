// Renders Stream GAL display lists with Triage's own WebGL2 renderer
// (app/src/vs/triage/browser/eda/edaRenderer.ts) in headless Chromium
// (ROADMAP P1-3, P1-4): screenshots, frame times, and the pixel comparison
// against kicad-cli's SVG export.
//
//   node engines/eda/tests/render.mjs <prefix>... [--out dir] [--size 1600x1000]
//
// Each <prefix> is what `triage-eda-engine --dump <file> --out <prefix>` wrote:
// <prefix>.tdl (the display list) and <prefix>.info.json (the document info).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(path.join(root, 'app', 'smoke', 'package.json'));

/** The renderer and the display-list reader as browser modules (TypeScript stripped). */
function modules() {
  const ts = require('typescript');
  const compile = (file) =>
    ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  return {
    '/displayList.js': compile('app/src/vs/triage/common/eda/displayList.ts'),
    '/edaRenderer.js': compile('app/src/vs/triage/browser/eda/edaRenderer.ts').replace(
      '../../common/eda/displayList.js',
      './displayList.js',
    ),
  };
}

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c"></canvas>
<script type="module">
import { DisplayListModel } from './displayList.js';
import { EdaRenderer } from './edaRenderer.js';
window.render = async (name, width, height, options = {}) => {
  const info = await (await fetch('/' + name + '.info.json')).json();
  const doc = info.document;
  const bytes = new Uint8Array(await (await fetch('/' + name + '.tdl')).arrayBuffer());
  const model = new DisplayListModel();
  // A dump is one or more chunks back to back: split on the chunk headers.
  let offset = 0;
  const view = new DataView(bytes.buffer);
  const chunks = [];
  while (offset < bytes.length) {
    let next = offset + 20;
    // The next chunk starts at the next "TDL1" magic aligned to 4 bytes (8 bytes after its id).
    while (next + 12 <= bytes.length && view.getUint32(next + 8, true) !== 0x314C4454) next += 4;
    if (next + 12 > bytes.length) next = bytes.length;
    chunks.push(bytes.subarray(offset, next));
    offset = next;
  }
  const layers = new Set();
  for (const chunk of chunks) for (const l of model.apply(chunk).layers) layers.add(l);
  const canvas = document.getElementById('c');
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const renderer = new EdaRenderer(canvas);
  renderer.setBackground(options.background ?? doc.background ?? 0x000000ff);
  renderer.pixelsPerIuAtScale1 = doc.pixels_per_iu_at_scale_1 || 1;
  const only = options.layers ? new Set(options.layers) : undefined;
  renderer.setLayers((doc.layers ?? []).map((l) => ({ id: l.id, order: l.order ?? 0,
    visible: only ? only.has(l.id) : (l.visible ?? false) })));
  renderer.updateLayers(model, layers);
  const b = options.bbox ?? doc.bbox;
  const x0 = b.x0 ?? 0, y0 = b.y0 ?? 0, x1 = b.x1 ?? 0, y1 = b.y1 ?? 0;
  const camera = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    scale: Math.min(width / ((x1 - x0) * 1.02), height / ((y1 - y0) * 1.02)) };
  const first = renderer.draw(camera, width, height, 1);
  // Frame times while panning and zooming (the 60 fps budget, ROADMAP P1-4).
  const times = [];
  const gl = renderer.canvas.getContext('webgl2');
  const pixel = new Uint8Array(4);
  // readPixels waits for the frame (finish() may not, in software rendering).
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  sync();
  for (let i = 0; i < (options.frames ?? 20); i++) {
    const t = (i / 60) * Math.PI * 2;
    const c = { cx: camera.cx + Math.cos(t) * 40 / camera.scale, cy: camera.cy + Math.sin(t) * 40 / camera.scale,
      scale: camera.scale * (1 + 0.6 * Math.sin(t)) };
    const started = performance.now();
    renderer.draw(c, width, height, 1);
    sync();
    times.push(performance.now() - started);
  }
  renderer.draw(camera, width, height, 1);
  sync();
  times.sort((a, b) => a - b);
  return { stats: model.stats(), drawCalls: first.drawCalls, primitives: first.primitives,
    medianFrameMs: times[Math.floor(times.length / 2)], worstFrameMs: times[times.length - 1] };
};
window.ready = true;
</script></body></html>`;

export async function renderDumps(
  prefixes,
  { out, width = 1600, height = 1000, options = {} } = {},
) {
  const files = modules();
  const dirs = new Map(prefixes.map((prefix) => [path.basename(prefix), path.dirname(prefix)]));
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '/');
    if (url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    } else if (files[url]) {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(files[url]);
    } else {
      const name = path.basename(url).replace(/\.(tdl|info\.json)$/, '');
      const dir = dirs.get(name);
      try {
        response.writeHead(200).end(readFileSync(path.join(dir ?? '', path.basename(url))));
      } catch {
        response.writeHead(404).end();
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The preinstalled Playwright (found through NODE_PATH, which only require honours).
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const results = {};
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('console', (message) => console.log(`  [page] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready === true);
    mkdirSync(out, { recursive: true });
    for (const prefix of prefixes) {
      const name = path.basename(prefix);
      const result = await page.evaluate(
        ([n, w, h, o]) => window.render(n, w, h, o),
        [name, width, height, options[name] ?? options['*'] ?? {}],
      );
      console.log(`${name}: ${JSON.stringify(result)}`);
      const png = path.join(out, `${name}.png`);
      await page.screenshot({ path: png, clip: { x: 0, y: 0, width, height }, timeout: 300_000 });
      results[name] = { ...result, png };
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out =
    outIndex >= 0 ? args.splice(outIndex, 2)[1] : path.join(root, 'engines/eda/build/render');
  const sizeIndex = args.indexOf('--size');
  const [width, height] =
    sizeIndex >= 0 ? args.splice(sizeIndex, 2)[1].split('x').map(Number) : [1600, 1000];
  const results = await renderDumps(args, { out, width, height });
  writeFileSync(path.join(out, 'render.json'), `${JSON.stringify(results, null, 2)}\n`);
}
