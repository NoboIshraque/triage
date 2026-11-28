// The 3D model on the phone (ROADMAP PC-5): the meshes the laptop's 3D tab
// draws (FreeCAD's engine and the board), with the same WebGL2 renderer
// (cadRenderer.ts). One finger orbits, two pan and pinch; a tap picks an
// object. Fit-check problems show red. With edit permission, an object's
// properties (the enclosure's wall thickness …) change on the laptop's engine,
// and both screens redraw. During a simulation the laptop streams where the
// rotor is and how the LEDs glow.

import {
  CadRenderer,
  type SceneObject,
} from '../../../app/src/vs/triage/browser/cad/cadRenderer.js';
import type {
  CadMesh,
  CadProperty,
  CadTreeItem,
} from '../../../app/src/vs/triage/common/cad/cadEngine.js';
import { h, replace, toast } from './dom.js';
import { attachGestures, frameScheduler } from './gestures.js';
import type { PhoneView, ViewHost } from './views.js';

interface SceneReply {
  documents: { name: string; label: string; objects: CadTreeItem[] }[];
  objects: {
    key: string;
    blob: number;
    colour?: [number, number, number];
    visible: boolean;
    problem: boolean;
    highlightFaces?: number[];
    model?: number[];
    emissive?: [number, number, number];
  }[];
  problems: string[];
  missing?: boolean;
}

function floats(bytes: Uint8Array | undefined): Float32Array {
  return bytes ? new Float32Array(bytes.slice().buffer) : new Float32Array(0);
}

function uints(bytes: Uint8Array | undefined): Uint32Array {
  return bytes ? new Uint32Array(bytes.slice().buffer) : new Uint32Array(0);
}

export class CadPhoneView implements PhoneView {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly side: HTMLElement;
  private readonly toolbar: HTMLElement;
  private renderer: CadRenderer | undefined;
  private scene: SceneReply | undefined;
  private selected: string | undefined;
  private fitted = false;
  private readonly cleanups: (() => void)[] = [];
  private loading: Promise<void> | undefined;
  readonly frames: number[] = [];
  private readonly requestDraw = frameScheduler(() => {
    this.draw();
  });

  constructor(private readonly host: ViewHost) {
    this.canvas = h('canvas.cad-canvas');
    this.toolbar = h('div.toolbar');
    this.side = h('div.panel', { hidden: true });
    this.element = h(
      'section.view.cad',
      { dataset: { view: '3d', state: 'loading' } },
      this.toolbar,
      h('div.stage', {}, this.canvas),
      this.side,
    );
    try {
      this.renderer = new CadRenderer(this.canvas);
    } catch (error) {
      this.element.append(
        h('p.error', {}, `This phone's browser can't draw with WebGL2: ${String(error)}`),
      );
    }
    const resize = new ResizeObserver(() => {
      this.requestDraw();
    });
    resize.observe(this.canvas);
    this.cleanups.push(() => {
      resize.disconnect();
    });
    this.cleanups.push(
      attachGestures(this.canvas, {
        drag: (dx, dy) => {
          this.renderer?.orbit(dx, dy);
          this.requestDraw();
        },
        pinch: (scale, _x, _y, dx, dy) => {
          this.renderer?.pan(dx, dy);
          this.renderer?.zoom(1 / scale);
          this.requestDraw();
        },
        tap: (x, y) => {
          const hit = this.renderer?.pick(x, y);
          this.select(hit?.key);
        },
        doubleTap: () => {
          this.renderer?.frame();
          this.requestDraw();
        },
      }),
    );
    replace(
      this.toolbar,
      h(
        'button',
        {
          dataset: { action: 'frame' },
          onclick: () => {
            this.renderer?.frame();
            this.requestDraw();
          },
        },
        'Frame',
      ),
      h(
        'button',
        {
          dataset: { action: 'iso' },
          onclick: () => {
            this.renderer?.setView('iso');
            this.requestDraw();
          },
        },
        'Iso',
      ),
      h(
        'button',
        {
          dataset: { action: 'top' },
          onclick: () => {
            this.renderer?.setView('top');
            this.requestDraw();
          },
        },
        'Top',
      ),
      h(
        'button',
        {
          dataset: { action: 'outliner' },
          onclick: () => {
            this.side.hidden = !this.side.hidden;
            this.renderSide();
          },
        },
        'Objects',
      ),
    );
  }

  open(): Promise<void> {
    return this.load();
  }

  private load(): Promise<void> {
    this.loading ??= this.fetchScene().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async fetchScene(): Promise<void> {
    const started = performance.now();
    const reply = await this.host.session.request('cad.scene', {});
    const scene = JSON.parse(reply.json) as SceneReply;
    this.scene = scene;
    if (scene.missing) {
      this.element.dataset['state'] = 'missing';
      this.host.status('Open the 3D tab on the laptop to see the model here.');
      return;
    }
    const renderer = this.renderer;
    if (!renderer) {
      return;
    }
    const keys = new Set(scene.objects.map((o) => o.key));
    for (const object of renderer.sceneObjects) {
      if (!keys.has(object.key)) {
        renderer.removeObject(object.key);
      }
    }
    let triangles = 0;
    for (const [index, o] of scene.objects.entries()) {
      const b = reply.blobs;
      const mesh: CadMesh = {
        requestId: 0,
        index,
        positions: floats(b[o.blob]),
        indices: uints(b[o.blob + 1]),
        faceStart: uints(b[o.blob + 2]),
        edgeStart: uints(b[o.blob + 3]),
        edgePoints: floats(b[o.blob + 4]),
      };
      triangles += mesh.indices.length / 3;
      const previous = renderer.getObject(o.key);
      const object: SceneObject = {
        key: o.key,
        mesh,
        ...(o.colour ? { colour: o.colour } : {}),
        visible: previous?.visible ?? o.visible,
        selected: o.key === this.selected,
        problem: o.problem,
        ...(o.highlightFaces ? { highlightFaces: new Set(o.highlightFaces) } : {}),
        ...(o.model ? { model: new Float32Array(o.model) } : {}),
        ...(o.emissive ? { emissive: o.emissive } : {}),
      };
      renderer.setObject(object);
    }
    if (!this.fitted) {
      renderer.setView('iso');
      renderer.frame();
      this.fitted = true;
    }
    this.element.dataset['state'] = 'ready';
    this.element.dataset['objects'] = String(scene.objects.length);
    this.element.dataset['problems'] = String(scene.problems.length);
    this.host.status(
      `${scene.objects.length} objects, ${Math.round(triangles)} triangles in ${(performance.now() - started).toFixed(0)} ms${scene.problems.length ? ` · ${scene.problems.length} fit problem(s)` : ''}`,
    );
    this.renderSide();
    this.requestDraw();
  }

  private draw(): void {
    if (!this.renderer || this.canvas.clientWidth <= 1) {
      return;
    }
    const ms = this.renderer.render();
    this.frames.push(ms);
    if (this.frames.length > 240) {
      this.frames.shift();
    }
    this.element.dataset['frameMs'] = ms.toFixed(2);
  }

  private select(key: string | undefined): void {
    this.selected = key;
    for (const object of this.renderer?.sceneObjects ?? []) {
      object.selected = object.key === key;
    }
    this.element.dataset['selected'] = key ?? '';
    this.requestDraw();
    if (key) {
      this.side.hidden = false;
    }
    this.renderSide();
  }

  private renderSide(): void {
    if (this.side.hidden || !this.scene) {
      return;
    }
    const rows: HTMLElement[] = [h('div.title', {}, 'Objects')];
    for (const problem of this.scene.problems) {
      rows.push(h('div.problem', {}, problem));
    }
    for (const doc of this.scene.documents) {
      rows.push(h('div.group', {}, doc.label));
      for (const item of doc.objects.filter((o) => o.shown)) {
        const key = `${doc.name}/${item.name}`;
        const drawn = this.renderer?.getObject(key);
        const eye = h(
          'button.eye',
          {
            onclick: () => {
              if (drawn) {
                drawn.visible = !drawn.visible;
                this.renderSide();
                this.requestDraw();
              }
            },
          },
          drawn?.visible === false ? '○' : '●',
        );
        const label = h(
          'button.object',
          {
            onclick: () => {
              this.select(key);
            },
          },
          item.label,
        );
        if (key === this.selected) {
          label.classList.add('selected');
        }
        rows.push(h('div.row', {}, eye, label));
      }
    }
    const properties = h('div.properties');
    rows.push(properties);
    replace(this.side, ...rows);
    if (this.selected) {
      void this.renderProperties(properties, this.selected);
    }
  }

  private async renderProperties(container: HTMLElement, key: string): Promise<void> {
    const [doc = '', object = ''] = key.split('/');
    try {
      const reply = await this.host.session.request('cad.properties', { doc, object });
      const result = JSON.parse(reply.json) as {
        label: string;
        type: string;
        properties: CadProperty[];
      };
      const edit = this.host.permission() === 'edit';
      const rows = result.properties.filter(
        (p) =>
          !p.hidden &&
          [
            'App::PropertyLength',
            'App::PropertyDistance',
            'App::PropertyFloat',
            'App::PropertyInteger',
            'App::PropertyBool',
            'App::PropertyString',
          ].includes(p.type),
      );
      replace(
        container,
        h('div.title', {}, `${result.label} (${result.type})`),
        ...rows.map((p) => {
          const value =
            typeof p.value === 'object' && p.value !== null && 'value' in p.value
              ? p.value.value
              : p.value;
          const input = h('input', {
            value: String(value),
            disabled: !edit || p.readOnly,
            dataset: { property: p.name },
          });
          input.addEventListener('change', () => {
            const typed: unknown =
              p.type === 'App::PropertyBool'
                ? input.value === 'true'
                : p.type === 'App::PropertyString'
                  ? input.value
                  : Number(input.value);
            void this.host.session
              .request('cad.setProperty', {
                doc: p.doc || doc,
                object,
                property: p.name,
                value: typed,
              })
              .then(
                () => {
                  toast(`${p.name} changed on the laptop.`);
                },
                (e: unknown) => {
                  toast(e instanceof Error ? e.message : String(e));
                },
              );
          });
          return h('label.property', {}, h('span', {}, p.name), input);
        }),
      );
    } catch (error) {
      replace(container, h('p.error', {}, error instanceof Error ? error.message : String(error)));
    }
  }

  onEvent(kind: string, body: Record<string, unknown>): void {
    if (kind === 'event:cad.scene') {
      void this.load();
    } else if (kind === 'event:sim.frame') {
      const transforms =
        (body['transforms'] as
          { key: string; model?: number[]; emissive?: [number, number, number] }[] | undefined) ??
        [];
      const byKey = new Map(transforms.map((t) => [t.key, t]));
      for (const object of this.renderer?.sceneObjects ?? []) {
        const t = byKey.get(object.key);
        if (t?.model) {
          object.model = new Float32Array(t.model);
        } else {
          delete object.model;
        }
        if (t?.emissive) {
          object.emissive = t.emissive;
        } else {
          delete object.emissive;
        }
      }
      const angle = transforms.find((t) => t.model)?.model;
      this.element.dataset['simModel'] = angle
        ? angle
            .slice(0, 2)
            .map((v) => v.toFixed(3))
            .join(',')
        : '';
      this.requestDraw();
    } else if (kind === 'event:permission') {
      this.renderSide();
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.renderer?.dispose();
  }
}
