// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal's named values (constants): the modes it reads, the find step budget and the
// scrollbar and mouse timings, each with the ADR that set it (ADR 061).

/** DEC private mode 1: application cursor keys, which the wheel's arrow keys follow. */
export const APP_CURSOR_KEYS_MODE = 1;

/** DEC private mode 1004: the app hears `CSI I` / `CSI O` on focus changes. (webtty, ADR 053) */
export const FOCUS_EVENT_MODE = 1004;

/** The time the search may take in a frame, in milliseconds. (webtty, ADR 055) */
export const FIND_STEP_MS = 4;

/**
 * While output keeps changing the matches, they are read again at most every this many
 * times the last read took. (webtty, ADR 055)
 */
export const FIND_READ_BACKOFF = 10;

/** The scrollbar hides this long after the last scroll. */
export const SCROLLBAR_HIDE_DELAY_MS = 1500;

/** The scrollbar's fade in and fade out. */
export const SCROLLBAR_FADE_DURATION_MS = 200;

/** Link hover checks run at most once per this many milliseconds (about 60 fps). */
export const MOUSE_MOVE_THROTTLE_MS = 16;
