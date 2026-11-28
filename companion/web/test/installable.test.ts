// Chrome's installability criteria for the built app (ROADMAP PC-3), checked on
// dist/ (node build.mjs runs first): a manifest with a name, start URL and scope,
// standalone display, 192 and 512 px PNG icons (and a maskable one), a service
// worker with a fetch handler that caches the whole app, and the page linking
// the manifest under a strict content security policy. HTTPS comes from the host.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = path.resolve(import.meta.dirname, '..', 'dist');

function pngSize(file: string): [number, number] {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe.skipIf(!existsSync(path.join(dist, 'manifest.webmanifest')))(
  'the built phone app is installable',
  () => {
    it('has a complete web app manifest with the icons Chrome asks for', () => {
      const manifest = JSON.parse(
        readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'),
      ) as {
        name: string;
        short_name: string;
        start_url: string;
        scope: string;
        display: string;
        icons: { src: string; sizes: string; type: string; purpose: string }[];
      };
      expect(manifest.name).toBe('Triage');
      expect(manifest.short_name.length).toBeGreaterThan(0);
      expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
      expect(manifest.start_url).toBe('./');
      for (const [size, purpose] of [
        [192, 'any'],
        [512, 'any'],
        [512, 'maskable'],
      ] as const) {
        const icon = manifest.icons.find(
          (i) => i.sizes === `${size}x${size}` && i.purpose === purpose,
        );
        expect(icon, `${size} px ${purpose} icon`).toBeDefined();
        expect(pngSize(path.join(dist, icon?.src ?? ''))).toEqual([size, size]);
      }
    });

    it('caches the whole app in a service worker with a fetch handler', () => {
      const sw = readFileSync(path.join(dist, 'sw.js'), 'utf8');
      expect(sw).toContain("addEventListener('fetch'");
      const shell = JSON.parse(/const SHELL = (\[[\s\S]*?\]);/.exec(sw)?.[1] ?? '[]') as string[];
      for (const file of [
        './index.html',
        './app.css',
        './manifest.webmanifest',
        './vendor/jsQR.js',
        './js/companion/web/src/main.js',
        './js/app/src/vs/triage/browser/eda/edaRenderer.js',
      ]) {
        expect(shell).toContain(file);
      }
      for (const file of shell.slice(1)) {
        expect(existsSync(path.join(dist, file)), file).toBe(true);
      }
    });

    it('links the manifest and allows only its own code', () => {
      const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
      expect(html).toContain('rel="manifest"');
      expect(html).toMatch(/Content-Security-Policy[\s\S]*script-src 'self'/);
      expect(html).not.toMatch(/unsafe-inline|unsafe-eval/);
      // The pairing link's page keeps the secret in the fragment.
      expect(readFileSync(path.join(dist, 'p.js'), 'utf8')).toContain('location.hash');
    });
  },
);
