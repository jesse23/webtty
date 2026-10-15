// A 2D canvas context that records what is drawn on it (test fake, ADR 064), for the
// render painter tests that assert the exact calls and writes, in order.

/** The recording context and its log. */
export interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  /** Each call as `name(arg,arg)` and each property write as `name=value`, in order. */
  calls: string[];
}

/**
 * A `CanvasRenderingContext2D` stand-in that logs every method call and property write.
 * A written property reads back its value, as on a real context; any other read is a
 * method that logs its call.
 */
export function recordingContext(): RecordingContext {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (target, key) =>
      typeof key === 'string' && key in target
        ? target[key]
        : (...args: unknown[]) => calls.push(`${String(key)}(${args.join(',')})`),
    set: (target, key, value) => {
      target[key as string] = value;
      calls.push(`${String(key)}=${value}`);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
