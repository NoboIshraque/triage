// The phone app's shell (ROADMAP PC-3, PLAN §4.16 "What the user does"): pairing
// from the QR code's link or the in-app scanner (or a typed code through the
// relay), the six digits to compare, reconnecting by itself to paired laptops,
// the tab switcher with Follow laptop, Unlink, and install guidance.

import {
  connect,
  hasWebTransport,
  RelayLink,
} from '../../../app/src/vs/triage/browser/companion/links.js';
import {
  codeMailbox,
  codePsk,
  hasX25519,
} from '../../../app/src/vs/triage/common/companion/noise.js';
import type {
  CompanionPermission,
  CompanionViewInfo,
  CompanionWelcome,
} from '../../../app/src/vs/triage/common/companion/protocol.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  decodePairingLink,
  formatCode,
  normalizeCode,
  type QrPayload,
} from '../../../app/src/vs/triage/common/companion/qr.js';
import {
  CompanionClosed,
  CompanionSession,
  type SessionOptions,
} from '../../../app/src/vs/triage/common/companion/session.js';
import { CadPhoneView } from './cadView.js';
import { h, replace, toast } from './dom.js';
import { edaCall, EdaPhoneView } from './edaView.js';
import { scan } from './scanner.js';
import { SimPhoneView } from './simView.js';
import * as store from './store.js';
import type { PhoneView, ViewHost } from './views.js';

export const APP_VERSION = '0.1.0';

interface Config {
  /** The relay a typed code meets the laptop through (the owner's deployment, PC-7). */
  readonly relay?: string;
}

/** What the phone is called on the laptop until the person there renames it. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh.*Mobile/.test(ua)) {
    return 'iPad';
  }
  if (ua.includes('iPhone')) {
    return 'iPhone';
  }
  if (ua.includes('Android')) {
    return ua.includes('Mobile') ? 'Android phone' : 'Android tablet';
  }
  return 'Phone';
}

function isIos(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && 'ontouchend' in document)
  );
}

function standalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CompanionApp implements ViewHost {
  private readonly root: HTMLElement;
  private config: Config = {};
  private current: CompanionSession | undefined;
  private record: store.LaptopRecord | undefined;
  private welcome: CompanionWelcome | undefined;
  private permissionValue: CompanionPermission = 'view';
  private views: readonly CompanionViewInfo[] = [];
  private view: PhoneView | undefined;
  private viewId = '';
  private follow = false;
  private ping: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private installPrompt: (Event & { prompt: () => Promise<void> }) | undefined;
  private statusText = '';
  private connectedAt = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as Event & { prompt: () => Promise<void> };
      document.body.dataset['installable'] = 'true';
    });
    document.addEventListener('visibilitychange', () => {
      // A phone may suspend the app in the background: come back and ask for a fresh view.
      if (
        document.visibilityState === 'visible' &&
        this.record &&
        (!this.current || this.current.closed)
      ) {
        void this.reconnect(this.record);
      }
    });
    (globalThis as { triageCompanion?: unknown }).triageCompanion = this;
  }

  get session(): CompanionSession {
    if (!this.current) {
      throw new Error('not connected');
    }
    return this.current;
  }

  permission(): CompanionPermission {
    return this.permissionValue;
  }

  status(text: string): void {
    this.statusText = text;
    const line = this.root.querySelector('.statusbar');
    if (line) {
      line.textContent = text;
    }
  }

  /** For STATUS's numbers and the tests: the view's frame times and the link. */
  get stats(): Record<string, unknown> {
    const frames = (this.view as { frames?: number[] } | undefined)?.frames ?? [];
    return {
      route: this.current?.route,
      view: this.viewId,
      bytesIn: this.current?.bytesIn ?? 0,
      bytesOut: this.current?.bytesOut ?? 0,
      averageFrameMs: frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0,
      connectedMs: this.connectedAt,
    };
  }

  /** One KiCad-engine request through the laptop (tests: what a view-only phone may do). */
  eda(command: string, body: Record<string, unknown>): Promise<unknown> {
    return edaCall(this.session, command, body).then(({ response }) => response);
  }

  async start(): Promise<void> {
    try {
      this.config = (await (await fetch('./config.json', { cache: 'no-store' })).json()) as Config;
    } catch {
      this.config = {};
    }
    const problems: string[] = [];
    if (!globalThis.isSecureContext) {
      problems.push('This page must be opened over HTTPS.');
    } else if (!(await hasX25519())) {
      problems.push(
        'This browser lacks X25519 in WebCrypto: update it (Safari 17 or Chrome 133 and newer).',
      );
    }
    if (problems.length > 0) {
      this.screen(
        h('div.screen', {}, h('h1', {}, 'Triage'), ...problems.map((p) => h('p.error', {}, p))),
      );
      return;
    }
    const hash = location.hash.slice(1);
    if (hash.startsWith('p=')) {
      // The secret is in the fragment: take it out of the address bar and history.
      history.replaceState(null, '', location.pathname + location.search);
      try {
        const payload = decodePairingLink(hash);
        if (isIos() && !standalone()) {
          this.iosInstallFirst(payload);
        } else {
          await this.pair(payload);
        }
      } catch (error) {
        this.home(message(error));
      }
      return;
    }
    const laptops = (await store.laptops()).sort((a, b) => b.lastSeen - a.lastSeen);
    const latest = laptops.at(0);
    if (latest) {
      this.home();
      await this.reconnect(latest);
    } else {
      this.home();
    }
  }

  private screen(...children: HTMLElement[]): void {
    this.disposeView();
    replace(this.root, ...children);
  }

  // ---- Home --------------------------------------------------------------------------------

  private home(error?: string): void {
    void store.laptops().then((laptops) => {
      const list = laptops.map((record) =>
        h(
          'div.laptop',
          { dataset: { mailbox: record.mailbox } },
          h('div.name', {}, record.project ? record.project : record.name),
          h(
            'div.detail',
            {},
            `${record.name} · last seen ${new Date(record.lastSeen).toLocaleString()}`,
          ),
          h(
            'div.buttons',
            {},
            h(
              'button.primary',
              { dataset: { action: 'connect' }, onclick: () => void this.reconnect(record) },
              'Connect',
            ),
            h(
              'button',
              { dataset: { action: 'unlink' }, onclick: () => void this.unlink(record) },
              'Unlink',
            ),
          ),
        ),
      );
      const install = !standalone()
        ? isIos()
          ? h(
              'p.hint',
              {},
              'To install: tap the Share button, then Add to Home Screen. Pair inside the installed app: it keeps its own storage.',
            )
          : this.installPrompt
            ? h(
                'button',
                {
                  dataset: { action: 'install' },
                  onclick: () => void this.installPrompt?.prompt(),
                },
                'Install the app',
              )
            : h(
                'p.hint',
                {},
                "Install it from the browser's menu (Install app, or Add to Home screen).",
              )
        : null;
      this.screen(
        h(
          'div.screen.home',
          { dataset: { screen: 'home' } },
          h('img.logo', { src: './icons/icon.svg', alt: '' }),
          h('h1', {}, 'Triage on your phone'),
          h(
            'p',
            {},
            'See the schematic, board, 3D model and simulation of the project open on your laptop. The laptop does the work.',
          ),
          error ? h('p.error', { role: 'alert' }, error) : null,
          ...list,
          h(
            'div.buttons',
            {},
            h(
              'button.primary',
              {
                dataset: { action: 'scan' },
                onclick: () => {
                  this.scanner();
                },
              },
              'Scan the QR code',
            ),
            h(
              'button',
              {
                dataset: { action: 'code' },
                onclick: () => {
                  this.typedCode();
                },
              },
              'Type a code',
            ),
          ),
          h(
            'p.hint',
            {},
            'On the laptop: Show on Phone (the phone icon above a Triage tab) → Pair a New Phone.',
          ),
          hasWebTransport()
            ? null
            : h(
                'p.hint',
                {},
                "This browser can't reach the laptop directly (WebTransport needs iOS 26.4 or Chrome 100): only through the relay.",
              ),
          install,
          h('p.version', {}, `Triage companion ${APP_VERSION}`),
        ),
      );
    });
  }

  private iosInstallFirst(payload: QrPayload): void {
    this.screen(
      h(
        'div.screen',
        { dataset: { screen: 'install' } },
        h('h1', {}, 'Add Triage to the Home Screen first'),
        h(
          'p',
          {},
          "iPhone keeps an installed web app's storage apart from Safari's. To stay paired: tap Share, then Add to Home Screen, open Triage from the Home Screen and scan the QR code again there.",
        ),
        h(
          'div.buttons',
          {},
          h('button', { onclick: () => void this.pair(payload) }, 'Pair in Safari anyway'),
          h(
            'button',
            {
              onclick: () => {
                this.home();
              },
            },
            'Back',
          ),
        ),
      ),
    );
  }

  private scanner(): void {
    const video = h('video.scanner', { autoplay: true, muted: true });
    const abort = new AbortController();
    this.screen(
      h(
        'div.screen.scan',
        { dataset: { screen: 'scan' } },
        h('p', {}, 'Point the camera at the QR code on the laptop.'),
        video,
        h(
          'button',
          {
            onclick: () => {
              abort.abort();
              this.home();
            },
          },
          'Cancel',
        ),
      ),
    );
    scan(video, abort.signal).then(
      (text) => {
        try {
          void this.pair(decodePairingLink(text));
        } catch (error) {
          this.home(`That isn't a Triage code: ${message(error)}`);
        }
      },
      (error: unknown) => {
        if (!abort.signal.aborted) {
          this.home(`The camera didn't start: ${message(error)}. Type the code instead.`);
        }
      },
    );
  }

  private typedCode(): void {
    const input = h('input.code-input', {
      placeholder: 'ABCD-EFGH',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: false,
    });
    const relay = this.config.relay;
    this.screen(
      h(
        'div.screen',
        { dataset: { screen: 'code' } },
        h('h1', {}, 'Type the code'),
        h('p', {}, 'The 8 characters under the QR code on the laptop.'),
        relay
          ? null
          : h(
              'p.error',
              {},
              'Typed codes meet the laptop through the relay, and none is set up for this app yet. Scan the QR code instead.',
            ),
        input,
        h(
          'div.buttons',
          {},
          h(
            'button.primary',
            {
              disabled: !relay,
              onclick: () => {
                const code = normalizeCode(input.value);
                if (!code || !relay) {
                  toast("That isn't 8 characters of a Triage code.");
                  return;
                }
                void this.pairWithCode(code, relay);
              },
            },
            'Pair',
          ),
          h(
            'button',
            {
              onclick: () => {
                this.home();
              },
            },
            'Back',
          ),
        ),
      ),
    );
    input.focus();
  }

  // ---- Pairing and connecting --------------------------------------------------------------

  private pairingScreen(title: string, sas?: string): void {
    this.screen(
      h(
        'div.screen.pairing',
        { dataset: { screen: 'pairing', sas: sas ?? '' } },
        h('h1', {}, title),
        sas ? h('div.sas', {}, `${sas.slice(0, 3)} ${sas.slice(3)}`) : h('div.spinner'),
        sas
          ? h('p', {}, 'Check that the laptop shows the same six digits, then click Allow there.')
          : null,
        h(
          'button',
          {
            onclick: () => {
              this.current?.close();
              this.home();
            },
          },
          'Cancel',
        ),
      ),
    );
  }

  private hello(extra: Record<string, unknown> = {}): SessionOptions['hello'] {
    return {
      app: 'triage-companion-web',
      version: APP_VERSION,
      name: deviceName(),
      platform: navigator.platform,
      ...extra,
    };
  }

  async pair(payload: QrPayload): Promise<void> {
    if (payload.expires * 1000 < Date.now() - 60_000) {
      this.home('This QR code has expired. On the laptop, click Show Again.');
      return;
    }
    this.pairingScreen('Connecting to the laptop…');
    try {
      const key = await store.phoneKey();
      const link = await connect({
        addresses: payload.addresses,
        hashes: [payload.certificateHash],
        relay: payload.relay,
        mailbox: payload.id,
      });
      const session = await CompanionSession.start(link, {
        mode: 'pair',
        id: payload.id,
        staticKey: key,
        laptopKey: payload.laptopKey,
        psk: payload.secret,
        hello: this.hello(),
      });
      this.adopt(session, undefined, payload.view);
      this.pairingScreen('Compare the code', session.sas);
    } catch (error) {
      this.home(message(error));
    }
  }

  async pairWithCode(code: string, relay: string): Promise<void> {
    this.pairingScreen('Meeting the laptop through the relay…');
    try {
      const key = await store.phoneKey();
      const mailbox = await codeMailbox(code);
      const link = await RelayLink.open(relay, mailbox);
      const session = await CompanionSession.start(link, {
        mode: 'code',
        id: mailbox,
        psk: await codePsk(code),
        hello: this.hello({ phoneKey: base64UrlEncode(key.publicKey) }),
      });
      this.adopt(session, undefined, 'board');
      this.pairingScreen(`Code ${formatCode(code)}: compare the digits`, session.sas);
    } catch (error) {
      this.home(message(error));
    }
  }

  async reconnect(record: store.LaptopRecord): Promise<void> {
    clearTimeout(this.reconnectTimer);
    this.record = record;
    this.pairingScreen(`Connecting to ${record.project || record.name}…`);
    try {
      const key = await store.phoneKey();
      const mailbox = base64UrlDecode(record.mailbox);
      const link = await connect({
        addresses: record.addresses,
        hashes: record.certificateHashes.map(base64UrlDecode),
        relay: record.relay,
        mailbox,
      });
      const session = await CompanionSession.start(link, {
        mode: 'reconnect',
        id: mailbox,
        staticKey: key,
        laptopKey: base64UrlDecode(record.laptopKey),
        hello: this.hello(),
      });
      this.adopt(session, record, record.lastView);
    } catch (error) {
      const closed = error instanceof CompanionClosed ? error : undefined;
      if (closed?.reason === 'not-paired') {
        await store.forgetLaptop(record.mailbox);
        this.record = undefined;
      }
      this.home(message(error));
    }
  }

  /** Takes a started session: waits for the welcome, then shows the views. */
  private adopt(
    session: CompanionSession,
    record: store.LaptopRecord | undefined,
    firstView: string,
  ): void {
    this.current?.close();
    this.current = session;
    this.connectedAt = performance.now();
    let welcomed = false;
    session.onEvent((envelope) => {
      if (envelope.kind === 'event:welcome') {
        welcomed = true;
      }
      const body = (envelope.json ? JSON.parse(envelope.json) : {}) as Record<string, unknown>;
      void this.onEvent(session, envelope.kind, body, record, firstView);
    });
    session.onClose((closed) => {
      if (this.current !== session) {
        return;
      }
      clearInterval(this.ping);
      document.body.dataset['connection'] = 'closed';
      if (!welcomed) {
        // Closed before the laptop let it in (Deny, a timeout): back home, saying why.
        this.home(closed.message);
        return;
      }
      this.banner(closed.message, true);
      if (this.record && !['not-paired', 'denied', 'incompatible'].includes(closed.reason)) {
        const record = this.record;
        this.reconnectTimer = setTimeout(() => {
          if (document.visibilityState === 'visible') {
            void this.reconnect(record);
          }
        }, 5000);
      } else if (closed.reason === 'not-paired' && this.record) {
        void store.forgetLaptop(this.record.mailbox);
      }
    });
    clearInterval(this.ping);
    // Keeps relays and NATs from closing an idle connection.
    this.ping = setInterval(() => {
      session.notify('ping');
    }, 20_000);
  }

  private async onEvent(
    session: CompanionSession,
    kind: string,
    body: Record<string, unknown>,
    record: store.LaptopRecord | undefined,
    firstView: string,
  ): Promise<void> {
    switch (kind) {
      case 'event:pending':
        return;
      case 'event:welcome': {
        const welcome = body as unknown as CompanionWelcome;
        this.welcome = welcome;
        this.permissionValue = welcome.permission;
        this.views = welcome.views;
        const saved: store.LaptopRecord = {
          mailbox: welcome.mailbox !== '' ? welcome.mailbox : (record?.mailbox ?? ''),
          name: welcome.laptop,
          project: welcome.project,
          laptopKey: welcome.laptopKey !== '' ? welcome.laptopKey : (record?.laptopKey ?? ''),
          certificateHashes: welcome.certificateHashes.length
            ? welcome.certificateHashes
            : (record?.certificateHashes ?? []),
          addresses: welcome.addresses.length ? welcome.addresses : (record?.addresses ?? []),
          relay: welcome.relay ?? record?.relay,
          lastView: welcome.view || firstView,
          paired: record?.paired ?? Date.now(),
          lastSeen: Date.now(),
        };
        if (saved.mailbox && saved.laptopKey) {
          await store.saveLaptop(saved);
          this.record = saved;
        }
        document.body.dataset['connection'] = session.route;
        document.body.dataset['permission'] = welcome.permission;
        this.connectedAt = performance.now() - this.connectedAt;
        this.main(welcome.view || firstView);
        return;
      }
      case 'event:permission':
        this.permissionValue = body['permission'] as CompanionPermission;
        document.body.dataset['permission'] = this.permissionValue;
        this.banner(
          this.permissionValue === 'edit'
            ? 'The laptop allowed editing.'
            : 'The laptop made this phone view only.',
        );
        this.renderHeader();
        this.view?.onEvent(kind, body);
        return;
      case 'event:views':
        this.views = body['views'] as CompanionViewInfo[];
        this.renderHeader();
        return;
      case 'event:laptop':
        if (this.follow && typeof body['view'] === 'string' && body['view'] !== this.viewId) {
          this.showView(body['view']);
        }
        return;
      case 'event:show':
        if (typeof body['view'] === 'string') {
          this.showView(body['view']);
        }
        return;
      case 'event:certificates':
        if (this.record) {
          this.record = {
            ...this.record,
            certificateHashes: body['certificateHashes'] as string[],
          };
          await store.saveLaptop(this.record);
        }
        return;
      case 'event:reload':
        this.showView(this.viewId);
        return;
      default:
        this.view?.onEvent(kind, body);
    }
  }

  private async unlink(record: store.LaptopRecord): Promise<void> {
    if (
      !confirm(`Unlink ${record.project || record.name}? You'll need a new QR code to pair again.`)
    ) {
      return;
    }
    if (this.current && !this.current.closed && this.record?.mailbox === record.mailbox) {
      await this.current.request('unlink', {}).catch(() => undefined);
      this.current.close();
    }
    await store.forgetLaptop(record.mailbox);
    this.record = undefined;
    this.home();
  }

  // ---- The views ---------------------------------------------------------------------------

  private main(view: string): void {
    this.disposeView();
    replace(
      this.root,
      h('header.top'),
      h('div.banner', { hidden: true }),
      h('main.content'),
      h('footer.statusbar', {}, this.statusText),
    );
    this.renderHeader();
    this.showView(view);
  }

  private renderHeader(): void {
    const header = this.root.querySelector('header.top');
    if (!header) {
      return;
    }
    const tabs = this.views.map((v) =>
      h(
        'button.tab',
        {
          dataset: { view: v.id, active: String(v.id === this.viewId) },
          disabled: !v.available,
          title: v.detail ?? '',
          onclick: () => {
            this.follow = false;
            this.showView(v.id);
          },
        },
        v.label,
      ),
    );
    const menu = h(
      'details.menu',
      {},
      h('summary', { 'aria-label': 'Menu' }, '⋮'),
      h(
        'div.menu-items',
        {},
        h(
          'label',
          {},
          h('input', {
            type: 'checkbox',
            checked: this.follow,
            dataset: { action: 'follow' },
            onchange: (e: Event) => {
              this.follow = (e.target as HTMLInputElement).checked;
              void this.current?.request('follow', { on: this.follow }).then(
                (reply) => {
                  const laptopView = (JSON.parse(reply.json) as { view?: string }).view;
                  if (this.follow && laptopView) {
                    this.showView(laptopView);
                  }
                },
                () => undefined,
              );
            },
          }),
          ' Follow laptop',
        ),
        h(
          'div.detail',
          {},
          `${this.permissionValue === 'edit' ? 'View and edit' : 'View only'} · ${this.current?.route === 'relay' ? 'through the relay' : 'same network'}`,
        ),
        h(
          'button',
          { dataset: { action: 'benchmark' }, onclick: () => void this.benchmark() },
          'Benchmark this view',
        ),
        h(
          'button',
          {
            onclick: () => {
              this.current?.close();
              this.current = undefined;
              this.home();
            },
          },
          'Disconnect',
        ),
        this.unlinkButton(),
      ),
    );
    replace(
      header,
      h('nav.tabs', {}, ...tabs),
      h(
        'span.permission',
        { dataset: { permission: this.permissionValue } },
        this.permissionValue === 'edit' ? 'edit' : 'view',
      ),
      menu,
    );
  }

  /** Frames per second of the current view while it pans and zooms (the owner's check). */
  private async benchmark(): Promise<void> {
    const view = this.view;
    if (!view?.benchmark) {
      toast('This view has no benchmark.');
      return;
    }
    toast('Measuring for two seconds…', 2000);
    const fps = await view.benchmark();
    toast(`${this.viewId}: ${fps.toFixed(0)} frames per second`, 6000);
  }

  private unlinkButton(): HTMLElement | null {
    const record = this.record;
    return record
      ? h(
          'button',
          { dataset: { action: 'unlink' }, onclick: () => void this.unlink(record) },
          'Unlink this laptop',
        )
      : null;
  }

  private showView(id: string): void {
    const content = this.root.querySelector('main.content');
    if (!content || !this.current) {
      return;
    }
    this.disposeView();
    this.viewId = id;
    const view: PhoneView =
      id === '3d'
        ? new CadPhoneView(this)
        : id === 'sim'
          ? new SimPhoneView(this)
          : new EdaPhoneView(this, id === 'schematic' ? 'schematic' : 'board');
    this.view = view;
    replace(content, view.element);
    this.renderHeader();
    if (this.record) {
      this.record = { ...this.record, lastView: id };
      void store.saveLaptop(this.record);
    }
    view.open().catch((error: unknown) => {
      view.element.dataset['state'] = 'error';
      view.element.append(h('p.error', {}, message(error)));
    });
  }

  private disposeView(): void {
    this.view?.dispose();
    this.view = undefined;
  }

  private banner(text: string, persistent = false): void {
    const banner = this.root.querySelector<HTMLElement>('.banner');
    if (!banner) {
      toast(text);
      return;
    }
    const record = this.record;
    replace(
      banner,
      h('span', {}, text),
      record && persistent
        ? h('button', { onclick: () => void this.reconnect(record) }, 'Reconnect')
        : null,
    );
    banner.hidden = false;
    if (!persistent) {
      setTimeout(() => {
        banner.hidden = true;
      }, 4000);
    }
  }
}
