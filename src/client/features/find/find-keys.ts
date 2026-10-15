// What a key typed in the find field does (util, pure, ADR 055, ADR 060): the field's own
// Enter keys first, then the find shortcuts through a lookup the root passes in, so
// features/find never imports features/keyboard.

/** The key fields the find field reads. */
export type FieldKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>;

/** The shortcut action a key is, if any: the keyboard feature's lookup, passed in by the root. */
export type ShortcutActionOf = (e: FieldKeyEvent) => string | undefined;

/** What a key in the find field does, or null when it is the field's to type. */
export type FieldKeyAction = 'next' | 'previous' | 'close' | 'select';

/** What a key in the find field does: the field's own keys, then the find shortcuts. */
export function fieldKey(
  e: FieldKeyEvent,
  shortcutActionOf: ShortcutActionOf,
): FieldKeyAction | null {
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.shiftKey ? 'previous' : 'next';
  }
  switch (shortcutActionOf(e)) {
    case 'findClose':
      return 'close';
    case 'findNext':
      return 'next';
    case 'findPrevious':
      return 'previous';
    case 'find':
      return 'select';
  }
  return null;
}
