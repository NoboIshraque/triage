/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Sim tab's instruments, drawn (ROADMAP P3-5): the SSD1306's picture and the
 *  plots. No VS Code imports (PLAN §4.16's rule): the phone app draws them too.
 *--------------------------------------------------------------------------------------------*/

export const PLOT_COLOURS = ['#4fc1ff', '#f4b860', '#9cdc6c', '#f07178', '#c792ea', '#80cbc4', '#ffcb6b'];
/** Seconds of signal a plot shows. */
export const PLOT_SECONDS = 10;

export interface PlotSeries {
	readonly label: string;
	readonly unit: string;
	readonly colour: string;
	readonly t: number[];
	readonly v: number[];
}

/**
 * A 2D context kept in the CPU: instruments redraw many times a second, and a
 * GPU-backed canvas makes each redraw wait for the GPU, which with software
 * graphics falls behind until the window stops answering (App runs 88, 103).
 */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
	return canvas.getContext('2d', { willReadFrequently: true });
}

/** Draws an SSD1306's 1024 bytes (pages of 8 rows) onto a 128 × 64 canvas. */
export function drawOled(canvas: HTMLCanvasElement, buffer: readonly number[], on: boolean): void {
	const context = context2d(canvas);
	if (!context) {
		return;
	}
	const image = context.createImageData(128, 64);
	for (let y = 0; y < 64; y++) {
		for (let x = 0; x < 128; x++) {
			const lit = on && ((buffer[(y >> 3) * 128 + x] ?? 0) & (1 << (y & 7))) !== 0;
			const i = (y * 128 + x) * 4;
			image.data[i] = lit ? 140 : 8;
			image.data[i + 1] = lit ? 220 : 10;
			image.data[i + 2] = lit ? 255 : 18;
			image.data[i + 3] = 255;
		}
	}
	context.putImageData(image, 0, 0);
}

/** Adds a frame's points ([t, v, t, v …] per signal) and keeps the last PLOT_SECONDS. */
export function addPoints(series: Map<string, PlotSeries>, plots: Readonly<Record<string, readonly number[]>>, now: number): void {
	for (const [signal, points] of Object.entries(plots)) {
		const s = series.get(signal);
		if (!s) {
			continue;
		}
		for (let i = 0; i < points.length; i += 2) {
			s.t.push(points[i]);
			s.v.push(points[i + 1]);
		}
		const cut = s.t.findIndex(t => t >= now - PLOT_SECONDS);
		if (cut > 0) {
			s.t.splice(0, cut);
			s.v.splice(0, cut);
		}
	}
}

/** Draws the plots, each signal on its own scale; returns the legend's entries. */
export function drawPlot(canvas: HTMLCanvasElement, series: Iterable<PlotSeries>, dpr: number): { readonly text: string; readonly colour: string }[] {
	const all = [...series];
	const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
	const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const context = context2d(canvas);
	if (!context) {
		return [];
	}
	context.clearRect(0, 0, width, height);
	context.strokeStyle = 'rgba(128,128,128,0.25)';
	context.lineWidth = 1;
	for (let i = 1; i < 4; i++) {
		context.beginPath();
		context.moveTo(0, (height * i) / 4);
		context.lineTo(width, (height * i) / 4);
		context.stroke();
	}
	let end = 0;
	for (const s of all) {
		end = Math.max(end, s.t[s.t.length - 1] ?? 0);
	}
	const start = Math.max(0, end - PLOT_SECONDS);
	const legend: { text: string; colour: string }[] = [];
	for (const s of all) {
		if (s.t.length === 0) {
			continue;
		}
		// Each signal on its own scale, so currents and temperatures share the plot.
		let lo = Math.min(...s.v);
		let hi = Math.max(...s.v);
		if (hi - lo < 1e-9) {
			hi += 0.5;
			lo -= 0.5;
		}
		context.strokeStyle = s.colour;
		context.lineWidth = 1.5 * dpr;
		context.beginPath();
		for (let i = 0; i < s.t.length; i++) {
			const x = ((s.t[i] - start) / PLOT_SECONDS) * width;
			const y = height - 4 - ((s.v[i] - lo) / (hi - lo)) * (height - 8);
			if (i === 0) {
				context.moveTo(x, y);
			} else {
				context.lineTo(x, y);
			}
		}
		context.stroke();
		const last = s.v[s.v.length - 1];
		legend.push({ colour: s.colour, text: `${s.label}: ${Number(last.toPrecision(4))} ${s.unit}` });
	}
	return legend;
}
