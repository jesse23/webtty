// The rules for `keyboardBindings`: which entries are valid, how they are normalised and how
// user entries merge over the defaults by `(key, mods)` identity. A pure util module (ADR 062;
// the binding semantics are in the key-bindings SPEC).
import type { KeyboardBinding } from './config-schema';

/** The identity of a binding: its lower-cased key plus its sorted modifiers. */
function bindingKey(b: KeyboardBinding): string {
  const mods = [...(b.mods ?? [])].sort().join('+');
  return `${b.key.toLowerCase()}|${mods}`;
}

const VALID_MODS = new Set(['shift', 'ctrl', 'alt', 'meta']);

/** True for an entry shaped like a {@link KeyboardBinding}: string `key` and `chars`, and `mods` absent or an array. */
export function isValidBinding(b: unknown): b is KeyboardBinding {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  if (typeof o.key !== 'string' || typeof o.chars !== 'string') return false;
  if (o.mods !== undefined && !Array.isArray(o.mods)) return false;
  return true;
}

/** Lower-cases the key and modifiers and drops modifiers other than shift, ctrl, alt and meta. */
export function normalizeBinding(b: KeyboardBinding): KeyboardBinding {
  return {
    ...b,
    key: b.key.toLowerCase(),
    mods: (b.mods ?? []).map((m) => m.toLowerCase()).filter((m) => VALID_MODS.has(m)),
  };
}

/**
 * Merges user-supplied bindings over a set of defaults by `(key, mods)` identity.
 * User entries replace matching defaults; unmatched user entries are appended.
 *
 * @param defaults - Default bindings to merge over.
 * @param user - User-supplied bindings that override defaults.
 * @returns Merged bindings with user entries replacing matching defaults and new user entries appended.
 */
export function mergeKeyboardBindings(
  defaults: KeyboardBinding[],
  user: KeyboardBinding[],
): KeyboardBinding[] {
  const deduped = [...new Map(user.map((b) => [bindingKey(b), b])).values()];
  const overrides = new Map(deduped.map((b) => [bindingKey(b), b]));
  const merged = defaults.map((d) => overrides.get(bindingKey(d)) ?? d);
  const defaultKeys = new Set(defaults.map(bindingKey));
  for (const b of deduped) {
    if (!defaultKeys.has(bindingKey(b))) merged.push(b);
  }
  return merged;
}
