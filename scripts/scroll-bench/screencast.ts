// Records what the page shows with CDP's screencast: every frame Chrome presents, as a
// JPEG with the time it arrived, acknowledged at once so the stream never stalls
// (service over Cdp).

import { type Cdp, sleep } from './cdp';

/** One recorded frame: its arrival time (Date.now()) and its JPEG, base64. */
export interface CastFrame {
  time: number;
  jpeg: string;
}

/** The screencast's image settings. */
export interface CastOptions {
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

/** A running recording; `stop` ends it and returns its frames in arrival order. */
export interface Recording {
  stop(): Promise<CastFrame[]>;
}

/** Time for the screencast to deliver its first frame before the input starts. */
const WARM_UP_MS = 300;

/** Starts recording the page and resolves once the screencast has warmed up. */
export async function startRecording(cdp: Cdp, options: CastOptions): Promise<Recording> {
  const frames: CastFrame[] = [];
  const off = cdp.on('Page.screencastFrame', (params) => {
    frames.push({ time: Date.now(), jpeg: String(params.data) });
    // A frame that comes as the screencast stops may have its ack refused; that is fine.
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', everyNthFrame: 1, ...options });
  await sleep(WARM_UP_MS);
  return {
    async stop() {
      await cdp.send('Page.stopScreencast');
      off();
      return frames;
    },
  };
}
