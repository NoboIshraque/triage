// The schematic and board on the phone (ROADMAP PC-4, PLAN §4.16): KiCad's
// display lists from the laptop's engine, drawn by the same WebGL2 renderer as
// the laptop's tabs (edaRenderer.ts). Pan and pinch zoom stay on the phone; a
// tap asks the engine what is there. With edit permission: value, reference,
// move, rotate, delete, undo, redo and save, through the laptop's engine, in the
// same document and undo history as the laptop's tab.

import {
  EdaRenderer,
  type Camera,
  type LayerStyle,
} from '../../../app/src/vs/triage/browser/eda/edaRenderer.js';
import { DisplayListModel } from '../../../app/src/vs/triage/common/eda/displayList.js';
import * as api from '../../../app/src/vs/triage/common/eda/engineApi.generated.js';
import {
  decodeMessage,
  encodeMessage,
  type Message,
} from '../../../app/src/vs/triage/common/eda/protobuf.js';
import type { CompanionSession } from '../../../app/src/vs/triage/common/companion/session.js';
import { h, replace, toast } from './dom.js';
import { attachGestures, frameScheduler } from './gestures.js';
import type { PhoneView, ViewHost } from './views.js';

interface LayerInfo {
  id: number;
  name: string;
  order: number;
  visible: boolean;
  user: boolean;
  required: number;
}

let requestId = 1;

/** One triage.eda.v1 request through the laptop; resolves with the response and its display-list chunks. */
export async function edaCall(
  session: CompanionSession,
  command: string,
  body: Message,
): Promise<{ response: Message; chunks: Uint8Array[] }> {
  const request = encodeMessage(api.Request, { id: requestId++, [command]: body });
  const reply = await session.request('eda', {}, [request]);
  const first = reply.blobs.at(0);
  const rest = reply.blobs.slice(1);
  if (!first) {
    throw new Error('no response from the KiCad engine');
  }
  const response = decodeMessage(api.Response, first);
  if (!response['ok']) {
    throw new Error((response['error'] as string) || `${command} failed`);
  }
  // Chunks are read as Float32Arrays: each needs its own aligned buffer.
  return { response, chunks: rest.map((c) => c.slice()) };
}

export class EdaPhoneView implements PhoneView {
  readonly element: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly card: HTMLElement;
  private readonly panel: HTMLElement;
  private renderer: EdaRenderer | undefined;
  private readonly model = new DisplayListModel();
  private camera: Camera = { cx: 0, cy: 0, scale: 1 };
  private width = 1;
  private height = 1;
  private document = 0;
  private info: Message | undefined;
  private layers = new Map<number, LayerInfo>();
  private sheet = '';
  private selected: Message | undefined;
  private highlights: Message[] = [];
  private modified = false;
  private moving: { dx: number; dy: number } | undefined;
  private fitted = false;
  private readonly cleanups: (() => void)[] = [];
  private readonly requestDraw = frameScheduler(() => {
    this.draw();
  });
  /** Frame times, for the numbers in STATUS (PC-4 asks for 30 fps). */
  readonly frames: number[] = [];

  constructor(
    private readonly host: ViewHost,
    readonly kind: 'board' | 'schematic',
  ) {
    this.toolbar = h('div.toolbar');
    this.canvas = h('canvas.eda-canvas');
    this.overlay = h('canvas.eda-overlay');
    this.stage = h('div.stage', {}, this.canvas, this.overlay);
    this.card = h('div.card', { hidden: true });
    this.panel = h('div.panel', { hidden: true });
    this.element = h(
      'section.view.eda',
      { dataset: { view: kind, state: 'loading' } },
      this.toolbar,
      this.stage,
      this.panel,
      this.card,
    );
    try {
      this.renderer = new EdaRenderer(this.canvas);
    } catch (error) {
      this.element.append(
        h('p.error', {}, `This phone's browser can't draw with WebGL2: ${String(error)}`),
      );
    }
    const resize = new ResizeObserver(() => {
      const rect = this.stage.getBoundingClientRect();
      this.width = Math.max(1, rect.width);
      this.height = Math.max(1, rect.height);
      if (!this.fitted && this.info) {
        this.fit();
      }
      this.requestDraw();
    });
    resize.observe(this.stage);
    this.cleanups.push(() => {
      resize.disconnect();
    });
    this.cleanups.push(
      attachGestures(this.stage, {
        drag: (dx, dy) => {
          if (this.moving) {
            this.moving.dx += dx / this.camera.scale;
            this.moving.dy += dy / this.camera.scale;
          } else {
            this.camera.cx -= dx / this.camera.scale;
            this.camera.cy -= dy / this.camera.scale;
          }
          this.requestDraw();
        },
        pinch: (scale, x, y, dx, dy) => {
          const [wx, wy] = this.toWorld(x - dx, y - dy);
          this.camera.scale = Math.min(Math.max(this.camera.scale * scale, 1e-9), 10);
          this.camera.cx = wx - (x - this.width / 2) / this.camera.scale;
          this.camera.cy = wy - (y - this.height / 2) / this.camera.scale;
          this.requestDraw();
        },
        tap: (x, y) => void this.tap(x, y),
        doubleTap: () => {
          this.fit();
        },
        end: () => {
          if (this.moving && (this.moving.dx !== 0 || this.moving.dy !== 0)) {
            void this.commitMove();
          }
        },
      }),
    );
  }

  private toWorld(x: number, y: number): [number, number] {
    return [
      this.camera.cx + (x - this.width / 2) / this.camera.scale,
      this.camera.cy + (y - this.height / 2) / this.camera.scale,
    ];
  }

  private toScreen(x: number, y: number): [number, number] {
    return [
      (x - this.camera.cx) * this.camera.scale + this.width / 2,
      (y - this.camera.cy) * this.camera.scale + this.height / 2,
    ];
  }

  async open(): Promise<void> {
    const reply = await this.host.session.request('view.open', { view: this.kind });
    const body = JSON.parse(reply.json) as { document: number; file: string };
    this.document = body.document;
    const infoBytes = reply.blobs.at(0);
    if (infoBytes) {
      this.setInfo(decodeMessage(api.DocumentInfo, infoBytes));
    }
    this.element.dataset['file'] = body.file;
    await this.loadDisplayList();
    this.fit();
    this.element.dataset['state'] = 'ready';
    this.renderToolbar();
  }

  private setInfo(info: Message): void {
    this.info = info;
    this.renderer?.setBackground(info['background'] as number);
    if (this.renderer) {
      this.renderer.pixelsPerIuAtScale1 = (info['pixelsPerIuAtScale1'] as number) || 1;
    }
    const old = this.layers;
    this.layers = new Map();
    for (const layer of info['layers'] as Message[]) {
      const id = layer['id'] as number;
      this.layers.set(id, {
        id,
        name: layer['name'] as string,
        order: layer['order'] as number,
        visible: old.get(id)?.visible ?? (layer['visible'] as boolean),
        user: layer['user'] as boolean,
        required: layer['required'] as number,
      });
    }
    this.applyLayers();
  }

  private applyLayers(): void {
    const styles: LayerStyle[] = [...this.layers.values()].map((layer) => {
      const base = this.layers.get(layer.required);
      return {
        id: layer.id,
        order: layer.order,
        visible: layer.visible && (base === undefined || base === layer || base.visible),
      };
    });
    this.renderer?.setLayers(styles);
    this.requestDraw();
  }

  private async loadDisplayList(): Promise<void> {
    const started = performance.now();
    const { response, chunks } = await edaCall(this.host.session, 'getDisplayList', {
      document: this.document,
      sheet: this.sheet,
    });
    if (response['documentInfo']) {
      this.setInfo(response['documentInfo'] as Message);
    }
    this.model.clear();
    this.renderer?.clear();
    this.applyChunks(chunks);
    const stats = this.model.stats();
    this.element.dataset['groups'] = String(stats.groups);
    this.element.dataset['loadMs'] = (performance.now() - started).toFixed(0);
    this.host.status(
      `${this.element.dataset['file'] ?? ''}: ${stats.groups} groups in ${(performance.now() - started).toFixed(0)} ms`,
    );
  }

  private applyChunks(chunks: readonly Uint8Array[]): void {
    const layers = new Set<number>();
    for (const chunk of chunks) {
      for (const layer of this.model.apply(chunk).layers) {
        layers.add(layer);
      }
    }
    this.renderer?.updateLayers(this.model, layers);
    this.requestDraw();
  }

  fit(): void {
    const box = (this.info?.['content'] ?? this.info?.['bbox']) as Message | undefined;
    if (!box || (box['x1'] as number) <= (box['x0'] as number) || this.width <= 1) {
      return;
    }
    const [x0, y0, x1, y1] = [box['x0'], box['y0'], box['x1'], box['y1']] as number[] as [
      number,
      number,
      number,
      number,
    ];
    this.fitted = true;
    this.camera = {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      scale: Math.min(this.width / ((x1 - x0) * 1.08), this.height / ((y1 - y0) * 1.08)),
    };
    this.requestDraw();
  }

  private draw(): void {
    if (!this.renderer || this.width <= 1) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const stats = this.renderer.draw(this.camera, this.width, this.height, ratio);
    this.frames.push(stats.milliseconds);
    if (this.frames.length > 240) {
      this.frames.shift();
    }
    this.element.dataset['frameMs'] = stats.milliseconds.toFixed(2);
    this.drawOverlay(ratio);
  }

  private drawOverlay(ratio: number): void {
    const o = this.overlay;
    const w = Math.round(this.width * ratio);
    const hgt = Math.round(this.height * ratio);
    if (o.width !== w || o.height !== hgt) {
      o.width = w;
      o.height = hgt;
    }
    const g = o.getContext('2d');
    if (!g) {
      return;
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    const outline = (item: Message, colour: string) => {
      const b = item['bbox'] as Message | undefined;
      if (!b) {
        return;
      }
      const dx = item === this.selected && this.moving ? this.moving.dx : 0;
      const dy = item === this.selected && this.moving ? this.moving.dy : 0;
      const [x0, y0] = this.toScreen((b['x0'] as number) + dx, (b['y0'] as number) + dy);
      const [x1, y1] = this.toScreen((b['x1'] as number) + dx, (b['y1'] as number) + dy);
      g.strokeStyle = colour;
      g.lineWidth = 2;
      g.setLineDash(this.moving && item === this.selected ? [6, 4] : []);
      g.strokeRect(
        Math.min(x0, x1) - 3,
        Math.min(y0, y1) - 3,
        Math.abs(x1 - x0) + 6,
        Math.abs(y1 - y0) + 6,
      );
    };
    for (const item of this.highlights) {
      outline(item, 'rgba(80, 170, 255, 0.9)');
    }
    if (this.selected) {
      outline(this.selected, 'rgba(255, 200, 40, 0.95)');
    }
  }

  private async tap(x: number, y: number): Promise<void> {
    if (this.moving) {
      return;
    }
    const [wx, wy] = this.toWorld(x, y);
    try {
      const { response } = await edaCall(this.host.session, 'hitTest', {
        document: this.document,
        x: wx,
        y: wy,
        tolerance: 14 / this.camera.scale,
      });
      const items = ((response['hitTest'] as Message | undefined)?.['items'] ?? []) as Message[];
      this.select(items.find((i) => i['reference']) ?? items[0]);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }

  private select(item: Message | undefined): void {
    this.selected = item;
    this.element.dataset['selected'] = (item?.['reference'] as string | undefined) ?? '';
    this.renderCard();
    this.requestDraw();
    const reference = item?.['reference'] as string | undefined;
    if (reference) {
      // Cross-probe: the laptop's tabs select it too.
      void this.host.session
        .request('select', {
          references: [reference],
          net: (item?.['net'] as string | undefined) ?? '',
        })
        .catch(() => undefined);
    }
  }

  private renderCard(): void {
    const item = this.selected;
    if (!item) {
      this.card.hidden = true;
      return;
    }
    const edit = this.host.permission() === 'edit';
    const uuid = item['uuid'] as string;
    const field = (label: string, value: unknown) =>
      typeof value === 'string' && value !== ''
        ? h('div.field', {}, h('span.label', {}, label), h('span.value', {}, value))
        : null;
    const buttons = h('div.buttons');
    const button = (label: string, run: () => Promise<void> | void, action: string) => {
      buttons.append(
        h(
          'button',
          {
            dataset: { action },
            onclick: () =>
              void Promise.resolve(run()).catch((e: unknown) => {
                toast(e instanceof Error ? e.message : String(e));
              }),
          },
          label,
        ),
      );
    };
    if (edit && item['reference']) {
      button(
        'Value…',
        async () => {
          const text = prompt(
            `New value for ${item['reference'] as string}`,
            (item['value'] as string | undefined) ?? '',
          );
          if (text !== null && text !== item['value']) {
            await this.edit({ setField: { uuid, field: 'Value', text } });
          }
        },
        'value',
      );
      button(
        'Reference…',
        async () => {
          const text = prompt('New reference', (item['reference'] as string | undefined) ?? '');
          if (text && text !== item['reference']) {
            await this.edit({ setField: { uuid, field: 'Reference', text } });
          }
        },
        'reference',
      );
      button('Rotate', () => this.edit({ rotate: { uuids: [uuid], degrees: 90 } }), 'rotate');
      button(
        this.moving ? 'Cancel move' : 'Move',
        () => {
          this.moving = this.moving ? undefined : { dx: 0, dy: 0 };
          if (this.moving) {
            toast('Drag to move it; it moves when you let go.');
          }
          this.renderCard();
          this.requestDraw();
        },
        'move',
      );
      button(
        'Delete',
        async () => {
          if (confirm(`Delete ${(item['reference'] as string | undefined) ?? 'this item'}?`)) {
            await this.edit({ delete: { uuids: [uuid] } });
            this.select(undefined);
          }
        },
        'delete',
      );
    }
    button(
      'Close',
      () => {
        this.moving = undefined;
        this.select(undefined);
      },
      'close',
    );
    replace(
      this.card,
      h(
        'div.title',
        {},
        typeof item['reference'] === 'string' && item['reference'] !== ''
          ? item['reference']
          : (item['type'] as string),
      ),
      field('Value', item['value']),
      field('Net', item['net']),
      h('div.description', {}, (item['description'] as string | undefined) ?? ''),
      buttons,
    );
    this.card.hidden = false;
  }

  private async commitMove(): Promise<void> {
    const item = this.selected;
    const moving = this.moving;
    this.moving = undefined;
    if (!item || !moving) {
      return;
    }
    await this.edit({ move: { uuids: [item['uuid'] as string], dx: moving.dx, dy: moving.dy } });
    this.renderCard();
  }

  /** One edit through the laptop's engine; applies the update it sends back. */
  private async edit(action: Message): Promise<void> {
    const { response, chunks } = await edaCall(this.host.session, 'edit', {
      document: this.document,
      ...action,
    });
    this.applyChunks(chunks);
    this.setModified(
      ((response['edit'] as Message | undefined)?.['modified'] as boolean | undefined) ?? true,
    );
    await this.refreshSelected();
  }

  private async undoRedo(which: 'undo' | 'redo'): Promise<void> {
    const { response, chunks } = await edaCall(this.host.session, which, {
      document: this.document,
    });
    this.applyChunks(chunks);
    this.setModified(
      ((response['edit'] as Message | undefined)?.['modified'] as boolean | undefined) ?? true,
    );
    await this.refreshSelected();
  }

  private async save(): Promise<void> {
    await edaCall(this.host.session, 'save', { document: this.document });
    this.setModified(false);
    toast('Saved on the laptop.');
  }

  private async refreshSelected(): Promise<void> {
    const uuid = this.selected?.['uuid'] as string | undefined;
    if (!uuid) {
      return;
    }
    const { response } = await edaCall(this.host.session, 'getItems', {
      document: this.document,
      uuids: [uuid],
    });
    const items = ((response['items'] as Message | undefined)?.['items'] ?? []) as Message[];
    this.selected = items[0];
    this.renderCard();
    this.requestDraw();
  }

  private setModified(modified: boolean): void {
    this.modified = modified;
    this.element.dataset['modified'] = String(modified);
    this.renderToolbar();
  }

  renderToolbar(): void {
    const edit = this.host.permission() === 'edit';
    const run = (work: () => Promise<void>) => () => {
      void work().catch((e: unknown) => {
        toast(e instanceof Error ? e.message : String(e));
      });
    };
    const items: (HTMLElement | null)[] = [
      h(
        'button',
        {
          onclick: () => {
            this.fit();
          },
          dataset: { action: 'fit' },
        },
        'Fit',
      ),
      h(
        'button',
        {
          onclick: () => {
            this.togglePanel();
          },
          dataset: { action: 'layers' },
        },
        this.kind === 'board' ? 'Layers' : 'Sheets',
      ),
    ];
    if (edit) {
      items.push(
        h(
          'button',
          { onclick: run(() => this.undoRedo('undo')), dataset: { action: 'undo' } },
          'Undo',
        ),
        h(
          'button',
          { onclick: run(() => this.undoRedo('redo')), dataset: { action: 'redo' } },
          'Redo',
        ),
        h('button', { onclick: run(() => this.save()), dataset: { action: 'save' } }, 'Save'),
      );
    }
    if (this.modified) {
      items.push(h('span.badge', {}, 'modified'));
    }
    replace(this.toolbar, ...items);
  }

  private togglePanel(): void {
    if (!this.panel.hidden) {
      this.panel.hidden = true;
      return;
    }
    if (this.kind === 'schematic') {
      const sheets = ((this.info?.['sheets'] ?? []) as Message[]).map((s) =>
        h(
          'button',
          {
            onclick: () => {
              this.sheet = s['path'] === '/' ? '' : (s['path'] as string);
              this.panel.hidden = true;
              this.fitted = false;
              void this.loadDisplayList().then(() => {
                this.fit();
              });
            },
          },
          `${s['page'] as string} ${s['name'] as string}`,
        ),
      );
      replace(this.panel, h('div.title', {}, 'Sheets'), ...sheets);
    } else {
      const user = [...this.layers.values()].filter((l) => l.user).sort((a, b) => a.id - b.id);
      replace(
        this.panel,
        h('div.title', {}, 'Layers'),
        ...user.map((layer) => {
          const box = h('input', { type: 'checkbox', checked: layer.visible });
          box.addEventListener('change', () => {
            layer.visible = box.checked;
            this.applyLayers();
          });
          return h('label.layer', {}, box, ` ${layer.name}`);
        }),
      );
    }
    this.panel.hidden = false;
  }

  onEvent(kind: string, body: Record<string, unknown>): void {
    if (kind === 'event:document' && body['document'] === this.document) {
      // The laptop (or another phone) changed it: draw it again, keeping the camera.
      void this.loadDisplayList().then(() => this.refreshSelected());
      if (body['command'] === 'save') {
        this.setModified(false);
      } else {
        this.setModified(true);
      }
    } else if (kind === 'event:select') {
      const references = (body['references'] as string[] | undefined) ?? [];
      void edaCall(this.host.session, 'getItems', { document: this.document, references }).then(
        ({ response }) => {
          this.highlights = ((response['items'] as Message | undefined)?.['items'] ??
            []) as Message[];
          this.requestDraw();
        },
        () => undefined,
      );
    } else if (kind === 'event:permission') {
      this.renderToolbar();
      this.renderCard();
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.renderer?.dispose();
  }
}
