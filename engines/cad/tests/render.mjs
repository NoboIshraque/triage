// Draws the CAD engine's meshes with Triage's own WebGL2 renderer
// (app/src/vs/triage/browser/cad/cadRenderer.ts) in headless Chromium (ROADMAP P2-3):
// screenshots, frame times, how much of the picture is covered, and picking.
//
//   node engines/cad/tests/render.mjs [--out dir] [--size 1200x800] [--board board3d.json]
//                                     [--explode mm]   (lifts an enclosure's lid)
//
// It opens the Smart Fan's FreeCAD documents through the staged engine, plus the
// board (board.update) when a GetBoard3D answer is given as JSON, and draws them
// from the front, the top and an iso view. Fails when a view draws nothing, or a
// pick at the middle of the iso view hits nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { startEngine } from './client.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(path.join(root, 'app', 'smoke', 'package.json'));

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
}

/** The renderer and the mesh reader as browser modules (TypeScript stripped). */
function modules() {
  const ts = require('typescript');
  const compile = (file) =>
    ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  return {
    '/cadEngine.js': compile('app/src/vs/triage/common/cad/cadEngine.ts'),
    '/cadRenderer.js': compile('app/src/vs/triage/browser/cad/cadRenderer.ts').replace(
      '../../common/cad/cadEngine.js',
      './cadEngine.js',
    ),
  };
}

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" style="display:block"></canvas>
<script type="module">
import { readMesh } from './cadEngine.js';
import { CadRenderer } from './cadRenderer.js';
let renderer;
window.load = async (width, height) => {
  const canvas = document.getElementById('c');
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  renderer = new CadRenderer(canvas);
  const index = await (await fetch('/meshes.json')).json();
  for (const entry of index) {
    const bytes = new Uint8Array(await (await fetch('/mesh/' + entry.file)).arrayBuffer());
    renderer.setObject({ key: entry.key, mesh: readMesh(bytes), colour: entry.colour ?? undefined, visible: true, selected: false, problem: false });
  }
  return index.length;
};
window.draw = (view) => {
  renderer.setView(view);
  renderer.frame();
  const times = [];
  for (let i = 0; i < 20; i++) times.push(renderer.render());
  const gl = renderer.canvas.getContext('webgl2');
  const w = renderer.canvas.width, h = renderer.canvas.height;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const bg = renderer.background.map(c => Math.round(c * 255));
  let covered = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i] - bg[0]) + Math.abs(pixels[i + 1] - bg[1]) + Math.abs(pixels[i + 2] - bg[2]) > 24) covered++;
  }
  times.sort((a, b) => a - b);
  return { coverage: covered / (w * h), medianCpuMs: times[10] };
};
window.pick = (x, y) => renderer.pick(x, y);
window.ready = true;
</script></body></html>`;

async function main() {
  const out = argument('--out', path.join(root, 'build', 'cad-render'));
  const [width, height] = argument('--size', '1200x800').split('x').map(Number);
  const boardFile = argument('--board');
  mkdirSync(out, { recursive: true });

  const engine = await startEngine();
  const files = new Map();
  const index = [];
  try {
    const add = (doc, result, meshes) => {
      for (const mesh of meshes) {
        const info = result.meshes[mesh.readUInt32LE(8)];
        const file = `${doc}-${info.object}.bin`;
        files.set(file, mesh);
        index.push({
          key: `${doc}/${info.object}`,
          file,
          colour: info.colour,
          triangles: info.triangles,
        });
      }
    };
    const manifest = readFileSync(path.join(root, 'examples', 'smart-fan', 'triage.toml'), 'utf8');
    const list = /\[mechanical\][^[]*?documents\s*=\s*\[([^\]]*)\]/s.exec(manifest)?.[1] ?? '';
    for (const name of [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1])) {
      const { result: opened } = await engine.call('document.open', {
        path: path.join(root, 'examples', 'smart-fan', 'mechanical', name),
      });
      const enclosure = opened.objects.find((o) => o.proxy === 'Enclosure');
      if (enclosure && argument('--explode')) {
        // Lifts the lid for the picture, so the board inside shows.
        await engine.call('object.setProperty', {
          doc: opened.name,
          object: enclosure.name,
          property: 'ExplodeLid',
          value: Number(argument('--explode')),
        });
      }
      const { result, meshes } = await engine.call('document.tessellate', { doc: opened.name });
      add(opened.name, result, meshes);
    }
    if (boardFile && existsSync(boardFile)) {
      const { result: board } = await engine.call('board.update', {
        board: JSON.parse(readFileSync(boardFile, 'utf8')),
      });
      const { result, meshes } = await engine.call('document.tessellate', { doc: board.doc });
      add(board.doc, result, meshes);
    }
  } finally {
    await engine.stop();
  }

  const pages = modules();
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    } else if (pages[url]) {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(pages[url]);
    } else if (url === '/meshes.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(index));
    } else if (url.startsWith('/mesh/') && files.has(url.slice(6))) {
      response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(files.get(url.slice(6)));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The preinstalled Playwright (found through NODE_PATH, which only require honours).
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const results = { objects: index.map(({ key, triangles }) => ({ key, triangles })), views: {} };
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready === true);
    await page.evaluate(([w, h]) => window.load(w, h), [width, height]);
    for (const view of ['front', 'top', 'iso']) {
      const result = await page.evaluate((v) => window.draw(v), view);
      await page.screenshot({ path: path.join(out, `cad-${view}.png`) });
      results.views[view] = result;
      if (result.coverage < 0.02) problems.push(`the ${view} view draws almost nothing`);
    }
    results.pick = await page.evaluate(([x, y]) => window.pick(x, y), [width / 2, height / 2]);
    if (!results.pick) problems.push('a pick at the middle of the iso view hit nothing');
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(path.join(out, 'cad-render.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  if (problems.length) throw new Error(problems.join('\n'));
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
