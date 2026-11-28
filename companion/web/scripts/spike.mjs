#!/usr/bin/env node
// The PC-1 spike in a session (ROADMAP PC-1): the built phone app (dist/) in a
// browser with phone emulation pairs with the laptop's real Rust server
// (triage_companion.node) over WebTransport, the certificate pinned by its hash
// from the QR link, and draws a board-sized display list. A scripted laptop
// answers the companion protocol (no KiCad engine here) and measures first-view
// time, throughput, frame rate and an edit's round trip.
//
//   node companion/web/build.mjs && node crates/triage-companion-node/build.mjs
//   node companion/web/scripts/spike.mjs [--segments 40000] [--device "Pixel 7"] [--out file.json]
//
// It needs Playwright and a Chromium (preinstalled in Claude's cloud sessions); CI
// runs the same path in the packaged app's smoke test instead (an Electron window).
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist');
const js = (p) => path.join(dist, 'js', 'app', 'src', 'vs', 'triage', p);
const require = createRequire(import.meta.url);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const addon = require(path.join(root, 'build', 'native', 'addons', 'triage_companion.node'));
const { encodeEnvelope, decodeEnvelope } = await import(js('common/companion/protocol.js'));
const api = await import(js('common/eda/engineApi.generated.js'));
const { encodeMessage, decodeMessage } = await import(js('common/eda/protobuf.js'));
const { DISPLAY_LIST_MAGIC } = await import(js('common/eda/displayList.js'));
const { chromium, devices } = require('playwright');

// ---- A board-sized display list (as engines/eda/triage/stream_gal writes it) ----
const MM = 1e6;
function chunk(groups, document) {
  const words = [1, 0, DISPLAY_LIST_MAGIC, document, 3];
  const f = new DataView(new ArrayBuffer(4));
  const f32 = (v) => {
    f.setFloat32(0, v, true);
    return f.getUint32(0, true);
  };
  for (const g of groups) {
    words.push(1, g.id, g.layer, g.order, 0, f32(0), 0, 0, g.runs.length);
    for (const run of g.runs) {
      words.push(run.kind, run.rgba >>> 0, run.data.length, ...run.data.map(f32));
    }
  }
  return new Uint8Array(new Uint32Array(words).buffer);
}
function board(segments) {
  const groups = [];
  const perGroup = 200;
  let id = 1;
  for (let i = 0; i < segments; i += perGroup) {
    const data = [];
    for (let k = 0; k < perGroup; k++) {
      const x = ((i + k) * 7919) % 78;
      const y = ((i + k) * 104729) % 58;
      data.push(
        (x + 1) * MM,
        (y + 1) * MM,
        (x + 1 + ((k % 5) - 2)) * MM,
        (y + 1 + ((k % 3) - 1)) * MM,
        0.25 * MM,
      );
    }
    id++;
    groups.push({
      id,
      layer: id % 2 ? 0 : 31,
      order: 10,
      runs: [{ kind: 2, rgba: id % 2 ? 0xc83434ff : 0x4d7fc4ff, data }],
    });
  }
  const pads = [];
  for (let k = 0; k < 400; k++)
    pads.push(((k % 20) * 4 + 2) * MM, (Math.floor(k / 20) * 3 + 1) * MM, 0.6 * MM, 0);
  groups.push({
    id: id + 1,
    layer: 0,
    order: 5,
    runs: [{ kind: 3, rgba: 0xd4b04aff, data: pads }],
  });
  return chunk(groups, 1);
}
const info = {
  document: 1,
  kind: 1,
  path: '/spike/smart-fan.kicad_pcb',
  background: 0x001023ff,
  iuPerMm: MM,
  pixelsPerIuAtScale1: 1,
  bbox: { x0: 0, y0: 0, x1: 80 * MM, y1: 60 * MM },
  content: { x0: 0, y0: 0, x1: 80 * MM, y1: 60 * MM },
  layers: [
    { id: 0, name: 'F.Cu', color: 0xc83434ff, order: 10, visible: true, user: true, required: 0 },
    { id: 31, name: 'B.Cu', color: 0x4d7fc4ff, order: 20, visible: true, user: true, required: 31 },
  ],
};
const r1 = {
  uuid: 'r1-uuid',
  type: 'FOOTPRINT',
  description: 'Footprint R1 on F.Cu',
  reference: 'R1',
  value: '10k',
  net: '',
  layer: 0,
  bbox: { x0: 10 * MM, y0: 10 * MM, x1: 16 * MM, y1: 13 * MM },
};

// ---- The phone app over HTTP (localhost is a secure context) ----
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};
const web = createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (file === '/' || file === '') file = '/index.html';
  if (file === '/p') file = '/p.html';
  const full = path.join(dist, file);
  if (!full.startsWith(dist) || !existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, { 'content-type': types[path.extname(full)] ?? 'application/octet-stream' })
    .end(readFileSync(full));
});
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
const appUrl = `http://127.0.0.1:${web.address().port}`;

// ---- The laptop: the real server, a scripted window ----
const keys = addon.generateKeypair();
const now = Date.now() / 1000;
const certificate = addon.currentCertificate(addon.planCertificates([], now), now);
const server = new addon.CompanionServer(keys.private);
server.setAllowedOrigins([appUrl]);
const port = await server.listen(0, certificate);
const id = addon.randomBytes(16);
const secret = addon.randomBytes(32);
server.addPairing(id, 'pair', secret, Date.now() + 90_000);
const link = addon.qrLink(
  {
    id,
    secret,
    laptopKey: keys.public,
    certificateHash: certificate.hash,
    expires: Math.floor(Date.now() / 1000) + 90,
    view: 'board',
    addresses: [`127.0.0.1:${port}`],
  },
  appUrl,
);
const segments = Number(arg('segments', '40000'));
const displayList = board(segments);
const edits = [];
const marks = {};
let sas = '';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
void (async () => {
  for (;;) {
    const event = await server.nextEvent();
    if (!event) return;
    if (event.kind === 'handshake') {
      sas = event.sas;
      marks.handshake = performance.now();
      setTimeout(() => {
        server.consumePairing(id);
        server.send(
          event.session,
          encodeEnvelope({
            kind: 'event:welcome',
            json: JSON.stringify({
              permission: 'edit',
              laptop: 'Triage (spike)',
              project: 'smart-fan',
              view: 'board',
              mailbox: b64(addon.randomBytes(16)),
              laptopKey: b64(keys.public),
              certificateHashes: [b64(certificate.hash)],
              addresses: [`127.0.0.1:${port}`],
              protocol: 1,
              triageVersion: 'spike',
              views: [
                { id: 'board', label: 'Board', available: true },
                { id: 'schematic', label: 'Schematic', available: false },
                { id: '3d', label: '3D', available: false },
                { id: 'sim', label: 'Sim', available: false },
              ],
            }),
          }),
        );
      }, 200);
    } else if (event.kind === 'message') {
      const request = decodeEnvelope(event.data);
      const reply = (json, blobs = []) =>
        server.sendWait(
          event.session,
          encodeEnvelope({
            replyTo: request.id,
            kind: request.kind,
            json: JSON.stringify(json),
            blobs,
          }),
        );
      if (request.kind === 'view.open') {
        await reply({ view: 'board', document: 1, file: 'smart-fan.kicad_pcb' }, [
          encodeMessage(api.DocumentInfo, info),
        ]);
      } else if (request.kind === 'eda') {
        const message = decodeMessage(api.Request, request.blobs[0]);
        const response = (extra) =>
          encodeMessage(api.Response, { id: message.id, ok: true, ...extra });
        if (message.getDisplayList) {
          marks.displayListAsked = performance.now();
          await reply({}, [response({}), displayList]);
        } else if (message.hitTest) {
          await reply({}, [response({ hitTest: { items: [r1] } })]);
        } else if (message.getItems) {
          await reply({}, [response({ items: { items: [r1] } })]);
        } else if (message.edit) {
          edits.push({ at: performance.now(), edit: message.edit });
          if (message.edit.setField) r1.value = message.edit.setField.text;
          await reply({}, [response({ edit: { modified: true, changed: [r1.uuid] } })]);
        } else {
          await reply({}, [response({})]);
        }
      } else if (request.id) {
        await reply({});
      }
    }
  }
})();

// ---- The phone ----
const device = arg('device', 'Pixel 7');
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const context = await browser.newContext({ ...devices[device] });
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => void d.accept('4.7k'));
const opened = performance.now();
await page.goto(link);
// iOS Safari asks to add the app to the Home Screen first (its storage is the app's own).
const first = await page.waitForSelector('[data-screen="install"], [data-screen="pairing"]', {
  timeout: 20_000,
});
if ((await first.getAttribute('data-screen')) === 'install') {
  await page.click('text=Pair in Safari anyway');
}
await page.waitForSelector('[data-screen="pairing"][data-sas]:not([data-sas=""])', {
  timeout: 20_000,
});
const shownSas = await page.getAttribute('[data-screen="pairing"]', 'data-sas');
await page.waitForSelector('.view.eda[data-state="ready"]', { timeout: 30_000 });
const firstView = performance.now() - opened;
await page.screenshot({ path: arg('shot', path.join(root, 'build', 'spike-board.png')) });
// Frame rate: pan and zoom for 120 frames, as the laptop's benchmark does; the
// draw call alone too (what a phone's GPU changes).
const fps = await page.evaluate(async () => {
  const stage = document.querySelector('.view.eda .stage');
  const view = document.querySelector('.view.eda');
  const rect = stage.getBoundingClientRect();
  const frames = [];
  const draws = [];
  let last = performance.now();
  for (let i = 0; i < 120; i++) {
    stage.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: Math.sin(i / 10) * 40,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
      }),
    );
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t = performance.now();
    frames.push(t - last);
    draws.push(Number(view.dataset.frameMs));
    last = t;
  }
  const mean = (a) => a.slice(5).reduce((x, y) => x + y, 0) / (a.length - 5);
  return {
    fps: 2000 / mean(frames),
    drawMs: mean(draws),
    loadMs: Number(view.dataset.loadMs),
    canvas: `${document.querySelector('.eda-canvas').width}x${document.querySelector('.eda-canvas').height}`,
  };
});
// The protocol's round trip (a sealed request and its reply), 20 times.
const roundTrip = await page.evaluate(async () => {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await globalThis.triageCompanion.session.request('ping', {});
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[10];
});
// Tap R1, change its value: the edit reaches the laptop.
const box = await page.locator('.view.eda .stage').boundingBox();
await page.mouse.click(box.x + box.width * 0.16, box.y + box.height * 0.2);
await page.waitForSelector('.card:not([hidden]) [data-action="value"]', { timeout: 10_000 });
await page.click('.card [data-action="value"]');
for (let i = 0; i < 200 && edits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
const stats = await page.evaluate(() => globalThis.triageCompanion.stats);
const result = {
  device,
  segments,
  displayListBytes: displayList.byteLength,
  sasMatches: shownSas === sas,
  firstViewMs: Math.round(firstView),
  displayListLoadMs: fps.loadMs,
  throughputMBps: Number((displayList.byteLength / 1e3 / Math.max(1, fps.loadMs)).toFixed(1)),
  canvas: fps.canvas,
  fps: Number(fps.fps.toFixed(1)),
  drawMs: Number(fps.drawMs.toFixed(2)),
  requestRoundTripMs: Number(roundTrip.toFixed(1)),
  editReached: edits[0]?.edit ?? null,
  bytesIn: stats.bytesIn,
  route: stats.route,
  errors: logs.filter((l) => l.startsWith('pageerror') || l.startsWith('error')),
};
console.log(JSON.stringify(result, null, 2));
const out = arg('out');
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
await browser.close();
await server.shutdown();
web.close();
process.exit(result.sasMatches && result.editReached ? 0 : 1);
