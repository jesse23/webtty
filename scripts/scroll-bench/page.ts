// The parts of the benchmark that run in the page, as expression strings evaluated through
// CDP: the paint counter (which animation frames drew on a canvas, and when wheel events
// came) and decoding screencast JPEGs into row brightness profiles (service over Cdp).

import type { Cdp } from './cdp';
import type { PaintFrame, Profile } from './metrics';
import type { Pointer } from './scenarios';

/**
 * Wraps the canvas drawing calls to flag a frame that drew, records every animation frame
 * and wheel event, and clears what an earlier run recorded. Installs once per page.
 */
const PAINT_COUNTER_RESET = `(() => {
  if (!window.__bench) {
    window.__bench = { drew: false, frames: [], wheels: [] };
    const P = CanvasRenderingContext2D.prototype;
    for (const m of ['fillText', 'fillRect', 'drawImage', 'clearRect', 'putImageData']) {
      const orig = P[m];
      P[m] = function (...a) { window.__bench.drew = true; return orig.apply(this, a); };
    }
    addEventListener('wheel', () => window.__bench.wheels.push(performance.now()), { capture: true });
    const tick = (t) => {
      window.__bench.frames.push([t, window.__bench.drew]);
      window.__bench.drew = false;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  window.__bench.frames.length = 0;
  window.__bench.wheels.length = 0;
})()`;

const PAINT_COUNTER_READ = `({ frames: window.__bench.frames, wheels: window.__bench.wheels })`;

/** What the paint counter recorded: animation frames and wheel event times, page clock. */
export interface PaintLog {
  frames: PaintFrame[];
  wheels: number[];
}

/** Installs the paint counter, or clears it when already installed. */
export async function resetPaintCounter(cdp: Cdp): Promise<void> {
  await cdp.eval(PAINT_COUNTER_RESET);
}

/** Reads what the paint counter recorded since its last reset. */
export function readPaintCounter(cdp: Cdp): Promise<PaintLog> {
  return cdp.eval<PaintLog>(PAINT_COUNTER_READ);
}

/** The columns a profile averages over, and which colour channels it reads. */
export interface ProfileRegion {
  x: number;
  /** At most this many columns; fewer when the frame is narrower. */
  width: number;
  /** `rg`: the mean of red and green (the scroll test); `r`: red alone (the stream test). */
  channels: 'rg' | 'r';
}

/** An expression decoding `jpegs` (base64) into one rounded profile per frame. */
export function profileExpression(jpegs: readonly string[], region: ProfileRegion): string {
  return `(async () => {
    const region = ${JSON.stringify(region)};
    const out = [];
    for (const data of ${JSON.stringify(jpegs)}) {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + data;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const w = Math.max(1, Math.min(region.width, img.width - 2 * region.x));
      const px = ctx.getImageData(region.x, 0, w, img.height).data;
      const prof = [];
      for (let y = 0; y < img.height; y++) {
        let sum = 0;
        for (let i = 0; i < w; i++) {
          const at = (y * w + i) * 4;
          sum += region.channels === 'rg' ? (px[at] + px[at + 1]) / 2 : px[at];
        }
        prof.push(Math.round((sum / w) * 100) / 100);
      }
      out.push(prof);
    }
    return out;
  })()`;
}

/** Frames decoded per evaluation, so no one expression carries megabytes of JPEG. */
const BATCH = 40;

/** Decodes screencast JPEGs into profiles in the page, a batch at a time. */
export async function decodeProfiles(
  cdp: Cdp,
  jpegs: readonly string[],
  region: ProfileRegion,
): Promise<Profile[]> {
  const profiles: Profile[] = [];
  for (let i = 0; i < jpegs.length; i += BATCH) {
    profiles.push(
      ...(await cdp.eval<number[][]>(profileExpression(jpegs.slice(i, i + BATCH), region))),
    );
  }
  return profiles;
}

/** The page point at `at`, fractions of its viewport, in CSS pixels. */
export function viewportPoint(cdp: Cdp, at: Pointer): Promise<{ x: number; y: number }> {
  return cdp.eval(
    `({ x: Math.round(innerWidth * ${at.x}), y: Math.round(innerHeight * ${at.y}) })`,
  );
}
