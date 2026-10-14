/**
 * A copy, paste, clear-screen (ADR 054) or find (ADR 055) key, as Ghostty binds them by
 * default. `performable`: when the action cannot be done (no selection to copy, the
 * alternate screen for a clear, no search open to close or move in) the key goes on to
 * the app, as Ghostty's `performable:` bindings do; otherwise it is consumed either way.
 * A paste is never the app's: without a clipboard API the browser's own paste is left to
 * run instead.
 */
export interface Shortcut {
  action: 'copy' | 'paste' | 'clear' | 'find' | 'findClose' | 'findNext' | 'findPrevious';
  performable: boolean;
}

type Keys = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** Whether the browser's platform takes Ghostty's macOS defaults (iPadOS and iOS too). */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

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
  }
  return null;
}
