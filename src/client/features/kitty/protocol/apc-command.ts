// A kitty graphics command parsed from an APC body (util, pure, ADR 032): its control
// keys and payload, and how a numeric key is read.

/** A command's control keys (`a=T`, `i=7`, ...) by name, values still strings. */
export type KittyKeys = Record<string, string>;

/** One parsed graphics command: what `parseKittyApc` returns and the assembler takes. */
export interface KittyCommand {
  keys: KittyKeys;
  payload: string;
}

/** Parses an APC body (`G<k=v,k=v>;<payload>`). Returns null if it is not graphics. */
export function parseKittyApc(body: string): KittyCommand | null {
  if (body[0] !== 'G') return null;
  const semi = body.indexOf(';');
  const control = semi < 0 ? body.slice(1) : body.slice(1, semi);
  const payload = semi < 0 ? '' : body.slice(semi + 1);
  const keys: KittyKeys = {};
  for (const pair of control.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { keys, payload };
}

/** Numeric key value, or `fallback` if absent / not a number. */
export function num(keys: KittyKeys, key: string, fallback = 0): number {
  const v = Number(keys[key]);
  return keys[key] !== undefined && Number.isFinite(v) ? v : fallback;
}
