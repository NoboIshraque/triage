// The in-app QR scanner (PLAN §4.16 step 3): iOS keeps an installed web app's
// storage apart from Safari's, so the installed app scans the code itself. It
// uses the browser's BarcodeDetector where there is one (Android), else jsQR
// (iOS has none), loaded as vendor/jsQR.js.

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

declare global {
  // jsQR's UMD build sets this.
  var jsQR:
    | ((data: Uint8ClampedArray, width: number, height: number) => { data: string } | null)
    | undefined;
}

function nativeDetector(): Detector | undefined {
  const Native = (
    globalThis as { BarcodeDetector?: new (options: { formats: string[] }) => Detector }
  ).BarcodeDetector;
  try {
    return Native ? new Native({ formats: ['qr_code'] }) : undefined;
  } catch {
    return undefined;
  }
}

/** Scans until a QR code is found (resolves with its text) or `signal` aborts. */
export async function scan(video: HTMLVideoElement, signal: AbortSignal): Promise<string> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  try {
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    await video.play();
    const detector = nativeDetector();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    for (;;) {
      if (signal.aborted) {
        throw new DOMException('cancelled', 'AbortError');
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (video.readyState < 2 || video.videoWidth === 0) {
        continue;
      }
      if (detector) {
        const codes = await detector.detect(video).catch(() => []);
        const found = codes[0]?.rawValue;
        if (found) {
          return found;
        }
        continue;
      }
      if (!context || !globalThis.jsQR) {
        throw new Error('No QR decoder in this browser: type the code instead.');
      }
      // A smaller copy decodes faster and still reads a phone-sized code.
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = globalThis.jsQR(image.data, image.width, image.height);
      if (code?.data) {
        return code.data;
      }
    }
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    video.srcObject = null;
  }
}
