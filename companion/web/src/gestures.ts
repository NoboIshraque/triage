// Touch on the phone's views (PLAN §4.16: pan, pinch zoom, tap; orbit in 3D).
// Pointer events, so a mouse works too (wheel zooms) for trying it on a laptop.

export interface GestureHandlers {
  /** One finger moved by (dx, dy) CSS pixels. */
  drag?: (dx: number, dy: number, x: number, y: number) => void;
  /** Two fingers: the centre moved by (dx, dy) and the spread changed by `scale` around (x, y). */
  pinch?: (scale: number, x: number, y: number, dx: number, dy: number) => void;
  /** A short touch without moving. */
  tap?: (x: number, y: number) => void;
  doubleTap?: (x: number, y: number) => void;
  /** A finger went down (a drag may follow). */
  down?: (x: number, y: number) => void;
  /** The last finger left after a drag. */
  end?: () => void;
}

const TAP_MOVE = 8;
const TAP_MS = 350;

export function attachGestures(element: HTMLElement, handlers: GestureHandlers): () => void {
  const points = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  let moved = false;
  let lastTap = 0;
  let pinch: { distance: number; cx: number; cy: number } | undefined;
  const local = (e: PointerEvent | WheelEvent) => {
    const rect = element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const spread = () => {
    const [a, b] = [...points.values()] as (typeof points extends Map<number, infer P>
      ? P | undefined
      : never)[];
    if (a === undefined || b === undefined) {
      return undefined;
    }
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  const onDown = (e: PointerEvent) => {
    element.setPointerCapture(e.pointerId);
    const p = local(e);
    points.set(e.pointerId, { ...p, x0: p.x, y0: p.y, t0: performance.now() });
    if (points.size === 1) {
      moved = false;
      handlers.down?.(p.x, p.y);
    }
    pinch = points.size === 2 ? spread() : undefined;
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    const point = points.get(e.pointerId);
    if (!point) {
      return;
    }
    const p = local(e);
    const dx = p.x - point.x;
    const dy = p.y - point.y;
    point.x = p.x;
    point.y = p.y;
    if (Math.hypot(p.x - point.x0, p.y - point.y0) > TAP_MOVE) {
      moved = true;
    }
    if (points.size >= 2 && pinch) {
      const now = spread();
      if (now && pinch.distance > 0) {
        handlers.pinch?.(
          now.distance / pinch.distance,
          now.cx,
          now.cy,
          now.cx - pinch.cx,
          now.cy - pinch.cy,
        );
        pinch = now;
      }
    } else if (points.size === 1 && moved) {
      handlers.drag?.(dx, dy, p.x, p.y);
    }
    e.preventDefault();
  };
  const onUp = (e: PointerEvent) => {
    const point = points.get(e.pointerId);
    points.delete(e.pointerId);
    pinch = points.size === 2 ? spread() : undefined;
    if (!point) {
      return;
    }
    if (points.size === 0) {
      const p = local(e);
      if (!moved && performance.now() - point.t0 < TAP_MS) {
        const now = performance.now();
        if (now - lastTap < 300) {
          lastTap = 0;
          handlers.doubleTap?.(p.x, p.y);
        } else {
          lastTap = now;
          handlers.tap?.(p.x, p.y);
        }
      } else {
        handlers.end?.();
      }
    }
  };
  const onWheel = (e: WheelEvent) => {
    const p = local(e);
    handlers.pinch?.(Math.exp(-e.deltaY * 0.0015), p.x, p.y, 0, 0);
    e.preventDefault();
  };
  element.style.touchAction = 'none';
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    element.removeEventListener('pointerdown', onDown);
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onUp);
    element.removeEventListener('wheel', onWheel);
  };
}

/** Runs `step(i)` once per display frame, `frames` times; returns frames per second. */
export async function measureFrames(frames: number, step: (i: number) => void): Promise<number> {
  const times: number[] = [];
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    step(i);
    const now = performance.now();
    times.push(now - last);
    last = now;
  }
  const settled = times.slice(5);
  return 1000 / (settled.reduce((a, b) => a + b, 0) / Math.max(1, settled.length));
}

/** Redraws at most once per display frame (GUIDELINES §10: per frame, not per message). */
export function frameScheduler(draw: () => void): () => void {
  let pending = false;
  return () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        draw();
      });
    }
  };
}
