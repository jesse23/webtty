// Turns the parsed JSON of a config file into a full Config. A pure util module: no file
// access, so every key's rule is tested with a table (ADR 062). Unknown keys and keys of the
// wrong type are ignored and fall back to DEFAULT_CONFIG; nothing here throws on bad values.
import type { Config, KeyboardBinding, RightClickBehavior } from './config-schema';
import { DEFAULT_CONFIG, DEFAULT_KEYBOARD_BINDINGS, DEFAULT_THEME } from './defaults';
import { isValidBinding, mergeKeyboardBindings, normalizeBinding } from './keyboard-bindings';

const RIGHT_CLICK_BEHAVIORS: readonly string[] = ['contextMenu', 'copyPaste', 'paste', 'none'];

/** A configured `rightClickBehavior`: `"default"` is the old name of `"contextMenu"`, and anything unknown is `"contextMenu"`. */
export function parseRightClickBehavior(value: string): RightClickBehavior {
  return RIGHT_CLICK_BEHAVIORS.includes(value) ? (value as RightClickBehavior) : 'contextMenu';
}

/** A finite number of zero or more; the rule shared by `scrollbackLines` and `padding`. */
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCursorStyle(value: unknown): value is Config['cursorStyle'] {
  return value === 'block' || value === 'bar' || value === 'underline';
}

/** The valid user bindings, normalised and merged over the defaults. */
function parseKeyboardBindings(user: unknown[]): KeyboardBinding[] {
  return mergeKeyboardBindings(
    DEFAULT_KEYBOARD_BINDINGS,
    user.filter(isValidBinding).map(normalizeBinding),
  );
}

/** The string-valued entries of a plain object; anything else in it is dropped. */
function parseEnv(env: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env as Record<string, unknown>).filter(
      ([k, v]) => typeof k === 'string' && typeof v === 'string',
    ) as [string, string][],
  );
}

/**
 * Merges the valid keys of a parsed config file over {@link DEFAULT_CONFIG}. The result keeps
 * DEFAULT_CONFIG's key order. `parsed` is expected to be an object (what `JSON.parse` returns
 * for a config file); `null` throws a TypeError, as loadConfig always has.
 */
export function parseConfig(parsed: unknown): Config {
  const p = parsed as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...(typeof p.port === 'number' && { port: p.port }),
    ...(typeof p.host === 'string' && { host: p.host }),
    ...(typeof p.shell === 'string' && { shell: p.shell }),
    ...(typeof p.term === 'string' && { term: p.term }),
    ...(typeof p.colorTerm === 'string' && { colorTerm: p.colorTerm }),
    ...(typeof p.scrollback === 'number' && { scrollback: p.scrollback }),
    ...(isNonNegativeFinite(p.scrollbackLines) && {
      scrollbackLines: Math.floor(p.scrollbackLines),
    }),
    ...(typeof p.cols === 'number' && { cols: p.cols }),
    ...(typeof p.rows === 'number' && { rows: p.rows }),
    ...(typeof p.fontSize === 'number' && { fontSize: p.fontSize }),
    ...(typeof p.fontFamily === 'string' && { fontFamily: p.fontFamily }),
    ...(isCursorStyle(p.cursorStyle) && { cursorStyle: p.cursorStyle }),
    ...(typeof p.cursorStyleBlink === 'boolean' && { cursorStyleBlink: p.cursorStyleBlink }),
    ...(typeof p.copyOnSelect === 'boolean' && { copyOnSelect: p.copyOnSelect }),
    ...(typeof p.rightClickBehavior === 'string' && {
      rightClickBehavior: parseRightClickBehavior(p.rightClickBehavior),
    }),
    ...(typeof p.clipboardWrite === 'boolean' && { clipboardWrite: p.clipboardWrite }),
    ...(typeof p.bellTitle === 'boolean' && { bellTitle: p.bellTitle }),
    ...(typeof p.desktopNotifications === 'boolean' && {
      desktopNotifications: p.desktopNotifications,
    }),
    ...(typeof p.mouseScrollSpeed === 'number' &&
      p.mouseScrollSpeed > 0 && { mouseScrollSpeed: p.mouseScrollSpeed }),
    ...(isNonNegativeFinite(p.padding) && { padding: Math.floor(p.padding) }),
    ...(typeof p.logs === 'boolean' && { logs: p.logs }),
    ...(p.theme && typeof p.theme === 'object' && { theme: { ...DEFAULT_THEME, ...p.theme } }),
    ...(Array.isArray(p.keyboardBindings) && {
      keyboardBindings: parseKeyboardBindings(p.keyboardBindings),
    }),
    ...(p.env && typeof p.env === 'object' && !Array.isArray(p.env) && { env: parseEnv(p.env) }),
  };
}
