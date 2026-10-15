// Matches a keydown against the configured key bindings (util, pure, ADR 018, ADR 060):
// keys compare case-insensitively and modifiers must match exactly, so `ctrl+k` does not
// fire for Ctrl+Shift+K.

import type { KeyboardBinding } from '../../app/client-config';

/** The key fields a binding is matched on. */
export type BindingKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
>;

/**
 * The first configured binding a keydown is, if any. A binding without chars still
 * matches: it claims the combo, so neither the terminal nor a shortcut sees it.
 */
export function findBinding(
  e: BindingKeyEvent,
  bindings: readonly KeyboardBinding[],
): KeyboardBinding | undefined {
  const key = e.key.toLowerCase();
  const active = new Set([
    ...(e.shiftKey ? ['shift'] : []),
    ...(e.ctrlKey ? ['ctrl'] : []),
    ...(e.altKey ? ['alt'] : []),
    ...(e.metaKey ? ['meta'] : []),
  ]);
  return bindings.find((b) => {
    if (b.key.toLowerCase() !== key) return false;
    const required = new Set((Array.isArray(b.mods) ? b.mods : []).map((m) => m.toLowerCase()));
    if (required.size !== active.size) return false;
    for (const m of required) if (!active.has(m)) return false;
    return true;
  });
}
