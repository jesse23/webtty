// Ghostty's default copy, paste, clear, find and jump-to-prompt keys, by platform (util,
// pure, ADR 014, ADR 054, ADR 055, ADR 057). The key dispatcher looks a keydown up here.

/**
 * A copy, paste, clear-screen (ADR 054), find (ADR 055) or jump-to-prompt (ADR 057) key,
 * as Ghostty binds them by default. `performable`: when the action cannot be done (no selection to copy, the
 * alternate screen for a clear, no search open to close or move in) the key goes on to
 * the app, as Ghostty's `performable:` bindings do; otherwise it is consumed either way.
 * A paste is never the app's: without a clipboard API the browser's own paste is left to
 * run instead.
 */
export interface Shortcut {
  action:
    | 'copy'
    | 'paste'
    | 'clear'
    | 'find'
    | 'findClose'
    | 'findNext'
    | 'findPrevious'
    | 'promptPrevious'
    | 'promptNext';
  performable: boolean;
}

type Keys = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/**
 * The shortcut a `keydown` is, if any. Modifiers match exactly, as in Ghostty, except for
 * Ctrl+V, which pastes with Shift or Alt held too, on every platform (ADR 014). Cmd+C and
 * Cmd+V are left to the input handler and the browser's `paste` event.
 */
export function shortcutFor(e: Keys, mac: boolean): Shortcut | null {
  if (e.ctrlKey && !e.metaKey && e.code === 'KeyV') return { action: 'paste', performable: false };
  const mods = `${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.metaKey ? 'super+' : ''}`;
  const trigger = `${mods}${e.code}`;
  if (trigger === 'Escape') return { action: 'findClose', performable: true };
  if (mac) {
    switch (trigger) {
      case 'super+KeyK':
        return { action: 'clear', performable: true };
      case 'super+KeyF':
        return { action: 'find', performable: false };
      case 'shift+super+KeyF':
        return { action: 'findClose', performable: true };
      case 'super+KeyG':
        return { action: 'findNext', performable: true };
      case 'shift+super+KeyG':
        return { action: 'findPrevious', performable: true };
      case 'super+ArrowUp':
      case 'shift+super+ArrowUp':
        return { action: 'promptPrevious', performable: false };
      case 'super+ArrowDown':
      case 'shift+super+ArrowDown':
        return { action: 'promptNext', performable: false };
    }
    return null;
  }
  switch (trigger) {
    case 'ctrl+shift+KeyF':
      return { action: 'find', performable: false };
    case 'ctrl+shift+KeyC':
      return { action: 'copy', performable: true };
    case 'ctrl+Insert':
      return { action: 'copy', performable: false };
    case 'shift+Insert':
      return { action: 'paste', performable: false };
    case 'ctrl+shift+ArrowUp':
      return { action: 'promptPrevious', performable: false };
    case 'ctrl+shift+ArrowDown':
      return { action: 'promptNext', performable: false };
  }
  return null;
}
