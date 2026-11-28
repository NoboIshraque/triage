// The phone app's entry point (companion/web, ROADMAP PC-3).
import { CompanionApp } from './app.js';

if (
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1')
) {
  // The offline shell: the app opens without the internet once installed.
  void navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
    console.warn('service worker', error);
  });
}

const root = document.getElementById('app');
if (root) {
  void new CompanionApp(root).start();
}
