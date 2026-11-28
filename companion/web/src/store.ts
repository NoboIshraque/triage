// What the phone keeps (PLAN §4.16): its own static key, a non-extractable
// WebCrypto key whose private half never leaves the browser, and the laptops it
// paired with (their public key, certificate hashes, addresses, mailbox). Never
// project files: the laptop holds those. iOS keeps a Home Screen app's storage
// apart from Safari's, so a phone pairs inside the installed app.

import {
  generateKeyPair,
  type NoiseKeyPair,
} from '../../../app/src/vs/triage/common/companion/noise.js';

export interface LaptopRecord {
  /** The phone's mailbox on this laptop, base64url (also its reconnect id). */
  readonly mailbox: string;
  readonly name: string;
  readonly project: string;
  /** The laptop's static key, base64url. */
  readonly laptopKey: string;
  readonly certificateHashes: readonly string[];
  readonly addresses: readonly string[];
  readonly relay?: string | undefined;
  readonly lastView: string;
  readonly paired: number;
  readonly lastSeen: number;
}

const DB = 'triage-companion';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('keys');
      request.result.createObjectStore('laptops', { keyPath: 'mailbox' });
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB failed'));
    };
  });
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB failed'));
      };
    });
  } finally {
    db.close();
  }
}

let cached: NoiseKeyPair | undefined;

/** The phone's static key, made on first use (non-extractable). */
export async function phoneKey(): Promise<NoiseKeyPair> {
  if (cached) {
    return cached;
  }
  const stored = await run<NoiseKeyPair | undefined>(
    'keys',
    'readonly',
    (s) => s.get('static') as IDBRequest<NoiseKeyPair | undefined>,
  );
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh = await generateKeyPair(false);
  await run('keys', 'readwrite', (s) => s.put(fresh, 'static'));
  cached = fresh;
  return fresh;
}

export function laptops(): Promise<LaptopRecord[]> {
  return run<LaptopRecord[]>(
    'laptops',
    'readonly',
    (s) => s.getAll() as IDBRequest<LaptopRecord[]>,
  );
}

export async function saveLaptop(record: LaptopRecord): Promise<void> {
  await run('laptops', 'readwrite', (s) => s.put(record));
}

export async function forgetLaptop(mailbox: string): Promise<void> {
  await run('laptops', 'readwrite', (s) => s.delete(mailbox));
}
