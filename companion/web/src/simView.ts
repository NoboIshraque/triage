// The simulation on the phone (ROADMAP PC-6): the laptop runs it; the phone
// shows its state at up to 30 Hz (dropped, not queued, when the phone lags), the
// OLED, plots and serial output with the Sim tab's own drawing code
// (simDrawing.ts). With edit permission: Run, Pause, Step, Stop, Speed, the scope
// picker, the environment and the parts' controls, the virtual I/O panel, the
// scenarios, and optionally the phone's tilt as the room temperature.

import {
  addPoints,
  drawOled,
  drawPlot,
  PLOT_COLOURS,
  type PlotSeries,
} from '../../../app/src/vs/triage/browser/sim/simDrawing.js';
import type {
  ISimFrame,
  ISimRunInfo,
  ISimScenarioResult,
  ISimScope,
  SimState,
} from '../../../app/src/vs/triage/common/sim/simTypes.js';
import { h, replace, toast } from './dom.js';
import { frameScheduler } from './gestures.js';
import type { PhoneView, ViewHost } from './views.js';

const SPEEDS: [string, number][] = [
  ['0.25×', 0.25],
  ['0.5×', 0.5],
  ['1×', 1],
  ['2×', 2],
  ['4×', 4],
  ['max', 0],
];

export class SimPhoneView implements PhoneView {
  readonly element: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly oled: HTMLCanvasElement;
  private readonly oledText: HTMLElement;
  private readonly plot: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly serial: HTMLElement;
  private readonly scenarios: HTMLElement;
  private readonly scopeSelect: HTMLSelectElement;
  private readonly speedSelect: HTMLSelectElement;
  private state: SimState = { kind: 'idle' };
  private frame: ISimFrame | undefined;
  private readonly series = new Map<string, PlotSeries>();
  private readonly indicators = new Map<string, HTMLElement>();
  private scenarioNames: string[] = [];
  private controlsFor = '';
  private serialText = '';
  private tilt: ((e: DeviceOrientationEvent) => void) | undefined;
  /** Frames received per second, for STATUS's numbers. */
  private frameTimes: number[] = [];
  private readonly requestDraw = frameScheduler(() => {
    this.draw();
  });

  constructor(private readonly host: ViewHost) {
    this.scopeSelect = h('select.scope', { dataset: { action: 'scope' } });
    this.speedSelect = h('select.speed', { dataset: { action: 'speed' } });
    for (const [label, value] of SPEEDS) {
      this.speedSelect.append(h('option', { value: String(value), selected: value === 1 }, label));
    }
    this.speedSelect.addEventListener('change', () => {
      void this.host.session
        .request('sim.setSpeed', { speed: Number(this.speedSelect.value) })
        .catch((e: unknown) => {
          this.fail(e);
        });
    });
    this.toolbar = h('div.toolbar');
    this.statusLine = h('div.status-line', {}, 'Not running');
    this.oled = h('canvas.oled', { width: 128, height: 64 });
    this.oledText = h('div.oled-text');
    this.plot = h('canvas.plot');
    this.legend = h('div.legend');
    this.controls = h('div.controls');
    this.serial = h('pre.serial');
    this.scenarios = h('div.scenarios');
    this.element = h(
      'section.view.sim',
      { dataset: { view: 'sim', state: 'idle' } },
      this.toolbar,
      this.statusLine,
      h(
        'div.instruments',
        {},
        h('div.oled-box', {}, this.oled, this.oledText),
        h('div.plot-box', {}, this.plot, this.legend),
      ),
      this.controls,
      h('details', {}, h('summary', {}, 'Serial monitor'), this.serial),
      h('details', {}, h('summary', {}, 'Scenarios'), this.scenarios),
    );
  }

  private fail(error: unknown): void {
    toast(error instanceof Error ? error.message : String(error));
  }

  private get edit(): boolean {
    return this.host.permission() === 'edit';
  }

  async open(): Promise<void> {
    const loaded = JSON.parse((await this.host.session.request('sim.load', {})).json) as {
      scopes: ISimScope[];
      scenarios: string[];
    };
    replace(this.scopeSelect, ...loaded.scopes.map((s) => h('option', { value: s.name }, s.name)));
    this.scenarioNames = loaded.scenarios;
    const current = JSON.parse((await this.host.session.request('sim.state', {})).json) as {
      state: SimState;
      frame?: ISimFrame;
    };
    this.renderToolbar();
    this.renderScenarios([]);
    this.setState(current.state);
    if (current.frame) {
      this.onFrame(current.frame);
    }
  }

  private renderToolbar(): void {
    const running = this.state.kind === 'running';
    const call =
      (kind: string, body: Record<string, unknown> = {}) =>
      () => {
        void this.host.session.request(kind, body).catch((e: unknown) => {
          this.fail(e);
        });
      };
    if (!this.edit) {
      replace(this.toolbar, h('span.hint', {}, 'View only: the laptop runs the simulation.'));
      return;
    }
    replace(
      this.toolbar,
      this.scopeSelect,
      h(
        'button.primary',
        {
          dataset: { action: 'run' },
          onclick: () => {
            void this.run().catch((e: unknown) => {
              this.fail(e);
            });
          },
        },
        running ? 'Pause' : 'Run',
      ),
      h(
        'button',
        { dataset: { action: 'step' }, onclick: call('sim.step', { seconds: 0.01 }) },
        'Step 10 ms',
      ),
      h('button', { dataset: { action: 'stop' }, onclick: call('sim.stop') }, 'Stop'),
      this.speedSelect,
    );
  }

  private async run(): Promise<void> {
    if (this.state.kind === 'running') {
      await this.host.session.request('sim.pause', {});
      return;
    }
    const info = 'info' in this.state ? this.state.info : undefined;
    if (info?.scope !== this.scopeSelect.value) {
      this.statusLine.textContent = 'Building on the laptop…';
      await this.host.session.request('sim.prepare', { scope: this.scopeSelect.value });
    }
    await this.host.session.request('sim.run', { speed: Number(this.speedSelect.value) });
  }

  private setState(state: SimState): void {
    this.state = state;
    this.element.dataset['state'] = state.kind;
    if ('info' in state) {
      this.scopeSelect.value = state.info.scope;
      this.renderControls(state.info);
    } else if (state.kind === 'idle') {
      this.renderControls(undefined);
    }
    this.statusLine.textContent =
      state.kind === 'building'
        ? `Building the ${state.what} on the laptop…`
        : state.kind === 'error'
          ? (state.message.split('\n')[0] ?? 'error')
          : state.kind === 'idle'
            ? 'Not running'
            : this.statusText();
    this.renderToolbar();
  }

  private statusText(): string {
    const f = this.frame;
    const scope = 'info' in this.state ? this.state.info.scope : '';
    return f
      ? `t = ${f.t.toFixed(2)} s · ${f.ratio.toFixed(2)}× real time · ${scope}${this.state.kind === 'paused' ? ' · paused' : ''}`
      : scope;
  }

  private renderControls(info: ISimRunInfo | undefined): void {
    const signature = info ? `${info.scope}|${info.controls.join()}` : '';
    if (signature === this.controlsFor) {
      return;
    }
    this.controlsFor = signature;
    this.indicators.clear();
    this.series.clear();
    if (!info) {
      replace(
        this.controls,
        h(
          'p.hint',
          {},
          'Pick a scope and press Run (with edit permission), or watch the laptop run it.',
        ),
      );
      return;
    }
    for (const [i, plotted] of info.plotted.entries()) {
      this.series.set(plotted.signal, {
        label: plotted.label,
        unit: plotted.unit,
        colour: PLOT_COLOURS[i % PLOT_COLOURS.length] ?? '#4fc1ff',
        t: [],
        v: [],
      });
    }
    const sections: HTMLElement[] = [];
    const disabled = !this.edit;
    const slider = (
      label: string,
      control: string,
      min: number,
      max: number,
      value: number,
      unit: string,
      scale = 1,
    ) => {
      const input = h('input', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String((max - min) / 200),
        value: String(value),
        disabled,
        dataset: { control },
      });
      const readout = h('span.value', {}, `${value.toFixed(2)} ${unit}`);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        readout.textContent = `${v.toFixed(2)} ${unit}`;
        void this.host.session
          .request('sim.input', { control, value: v * scale })
          .catch((e: unknown) => {
            this.fail(e);
          });
      });
      return h('div.row', {}, h('span.name', {}, label), input, readout);
    };
    const momentary = (label: string, control: string, pressed: number, released: number) => {
      const button = h('button.momentary', { disabled, dataset: { control } }, 'Press');
      const set = (down: boolean) => {
        button.classList.toggle('down', down);
        void this.host.session
          .request(down ? 'sim.input' : 'sim.release', {
            control,
            value: down ? pressed : released,
          })
          .catch((e: unknown) => {
            this.fail(e);
          });
      };
      button.addEventListener('pointerdown', () => {
        set(true);
      });
      button.addEventListener('pointerup', () => {
        set(false);
      });
      button.addEventListener('pointerleave', () => {
        if (button.classList.contains('down')) {
          set(false);
        }
      });
      return h('div.row', {}, h('span.name', {}, label), button);
    };
    if (info.controls.includes('env.room_temperature_c')) {
      const tilt = h(
        'button',
        {
          disabled,
          dataset: { action: 'tilt' },
          onclick: () => {
            void this.toggleTilt();
          },
        },
        this.tilt ? 'Stop tilt' : 'Tilt to set',
      );
      sections.push(
        h(
          'div.section',
          {},
          h('h3', {}, 'Environment'),
          slider('Room temperature', 'env.room_temperature_c', 10, 45, 24, '°C'),
          h('div.row', {}, h('span.name', {}, 'Phone tilt'), tilt),
        ),
      );
    }
    const parts = info.controls.filter((c) => /\.(pressed|position)$/.test(c));
    if (parts.length > 0) {
      sections.push(
        h(
          'div.section',
          {},
          h('h3', {}, 'Parts'),
          ...parts.map((c) => {
            const ref = c.split('.')[0] ?? c;
            return c.endsWith('.pressed') ? momentary(ref, c, 1, 0) : slider(ref, c, 0, 1, 0.5, '');
          }),
        ),
      );
    }
    if (info.ioPanel.length > 0) {
      sections.push(
        h(
          'div.section',
          {},
          h('h3', {}, 'Virtual I/O'),
          ...info.ioPanel.map((element) => {
            if (element.kind === 'button' && element.control) {
              return momentary(element.label, element.control, element.pressed, element.value);
            }
            if (element.kind === 'slider' && element.control) {
              return slider(
                element.label,
                element.control,
                element.min,
                element.max,
                element.value,
                'V',
              );
            }
            const led = h('span.led', { dataset: { signal: element.signal ?? '' } });
            if (element.signal) {
              this.indicators.set(element.signal, led);
            }
            return h('div.row', {}, h('span.name', {}, element.label), led);
          }),
        ),
      );
    }
    const stubs = info.stubs.filter((s) => s.kind !== 'hold' && s.kind !== 'open');
    const stubRows = stubs.flatMap((stub) => {
      if (info.controls.includes(`${stub.signal}.duty`)) {
        return [slider(`${stub.signal} PWM duty`, `${stub.signal}.duty`, 0, 1, 0.5, '')];
      }
      if (stub.signal.endsWith('.torque') && info.controls.includes(`${stub.signal}.value`)) {
        return [slider(`${stub.signal} (mN·m)`, `${stub.signal}.value`, 0, 5, 0, 'mN·m', 1e-3)];
      }
      return [];
    });
    if (stubRows.length > 0) {
      sections.push(h('div.section', {}, h('h3', {}, "Stubs at the scope's edge"), ...stubRows));
    }
    replace(this.controls, ...sections);
  }

  /** The phone's tilt as the room temperature: flat 24 °C, tilted towards you up to 45 °C. */
  private async toggleTilt(): Promise<void> {
    if (this.tilt) {
      window.removeEventListener('deviceorientation', this.tilt);
      this.tilt = undefined;
      this.controlsFor = '';
      this.renderControls('info' in this.state ? this.state.info : undefined);
      return;
    }
    const Orientation = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (Orientation.requestPermission && (await Orientation.requestPermission()) !== 'granted') {
      toast('The phone said no to motion sensors.');
      return;
    }
    let last = 0;
    this.tilt = (e: DeviceOrientationEvent) => {
      const now = performance.now();
      if (e.beta === null || now - last < 100) {
        return;
      }
      last = now;
      const value = Math.min(45, Math.max(10, 24 + (e.beta - 20) * 0.5));
      void this.host.session
        .request('sim.input', { control: 'env.room_temperature_c', value })
        .catch(() => undefined);
    };
    window.addEventListener('deviceorientation', this.tilt);
    this.controlsFor = '';
    this.renderControls('info' in this.state ? this.state.info : undefined);
  }

  private renderScenarios(results: readonly ISimScenarioResult[]): void {
    const rows = this.scenarioNames.map((name) => {
      const result = results.find((r) => r.file.endsWith(name));
      return h(
        'div.row',
        {
          dataset: { file: name, result: result ? (result.passed ? 'passed' : 'failed') : 'none' },
        },
        h('span.mark', {}, result ? (result.passed ? '✓' : '✗') : '·'),
        h('span.name', {}, result?.name ?? name),
        result
          ? h(
              'span.value',
              {},
              `${result.checks.filter((c) => c.passed).length}/${result.checks.length}`,
            )
          : null,
      );
    });
    const button = this.edit
      ? h(
          'button',
          {
            dataset: { action: 'scenarios' },
            onclick: () => {
              this.scenarios.dataset['running'] = 'true';
              void this.host.session.request('sim.runScenarios', {}).then(
                (reply) => {
                  delete this.scenarios.dataset['running'];
                  this.renderScenarios(
                    (JSON.parse(reply.json) as { results: ISimScenarioResult[] }).results,
                  );
                },
                (e: unknown) => {
                  delete this.scenarios.dataset['running'];
                  this.fail(e);
                },
              );
            },
          },
          'Run all scenarios',
        )
      : null;
    replace(this.scenarios, button, ...rows);
  }

  private onFrame(frame: ISimFrame): void {
    this.frame = frame;
    const now = performance.now();
    this.frameTimes.push(now);
    while ((this.frameTimes.at(0) ?? now) < now - 2000) {
      this.frameTimes.shift();
    }
    addPoints(this.series, frame.plots, frame.t);
    if (frame.serial) {
      this.serialText = (this.serialText + frame.serial).slice(-8000);
    }
    this.requestDraw();
  }

  /** Frames a second over the last two seconds. */
  get frameRate(): number {
    return this.frameTimes.length / 2;
  }

  private draw(): void {
    const frame = this.frame;
    if (!frame) {
      return;
    }
    this.statusLine.textContent = this.statusText();
    this.element.dataset['t'] = frame.t.toFixed(3);
    this.element.dataset['fps'] = this.frameRate.toFixed(1);
    for (const display of Object.values(frame.displays)) {
      drawOled(this.oled, display.buffer, display.on);
      this.oledText.textContent = display.text;
      this.element.dataset['oled'] = display.text;
    }
    const legend = drawPlot(this.plot, this.series.values(), window.devicePixelRatio || 1);
    replace(
      this.legend,
      ...legend.map((l) => {
        const span = h('span', {}, l.text);
        span.style.color = l.colour;
        return span;
      }),
    );
    for (const [signal, led] of this.indicators) {
      const value = frame.values[signal] ?? 0;
      led.classList.toggle(
        'on',
        value === 1 || value === 4 || (frame.duty[signal.split('.').pop() ?? ''] ?? 0) > 0.5,
      );
    }
    this.serial.textContent = this.serialText;
  }

  onEvent(kind: string, body: Record<string, unknown>): void {
    if (kind === 'event:sim.state') {
      this.setState(body['state'] as SimState);
    } else if (kind === 'event:sim.frame') {
      this.onFrame(body['frame'] as ISimFrame);
    } else if (kind === 'event:permission') {
      this.controlsFor = '';
      this.renderControls('info' in this.state ? this.state.info : undefined);
      this.renderToolbar();
      this.renderScenarios([]);
    }
  }

  dispose(): void {
    if (this.tilt) {
      window.removeEventListener('deviceorientation', this.tilt);
    }
  }
}
