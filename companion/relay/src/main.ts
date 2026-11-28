// Runs the relay: `node dist/main.js [--port 8080] [--host 0.0.0.0] [--trust-proxy]`
// (or PORT, HOST, TRUST_PROXY=1). Put it behind TLS (a reverse proxy or the host's
// own): phones and laptops connect with wss://.
import process from 'node:process';
import { Relay } from './relay.js';

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const relay = new Relay({
  trustProxy: process.argv.includes('--trust-proxy') || process.env['TRUST_PROXY'] === '1',
});
const port = await relay.listen(
  Number(option('port', process.env['PORT'] ?? '8080')),
  option('host', process.env['HOST'] ?? '0.0.0.0'),
);
console.log(`Triage companion relay listening on port ${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
