// Derived from coder/ghostty-web lib/types.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// What the binding reads out of Ghostty's render state (types): a decoded cell and its
// style flags, the cursor and the dirty state (ADR 047, ADR 061).

/** How much of the render state changed since the last frame, so the renderer can skip work. */
export enum DirtyState {
  NONE = 0,
  PARTIAL = 1,
  FULL = 2,
}

/** The cursor as the render state reports it: where, whether it shows, and its shape. */
export interface RenderStateCursor {
  x: number;
  y: number;
  viewportX: number; // -1 if not in viewport
  viewportY: number;
  visible: boolean;
  blinking: boolean;
  style: 'block' | 'underline' | 'bar';
}

/**
 * A cell as the binding decodes it from Ghostty's render state (webtty: the field
 * comments give ghostty-web's original C sizes)
 */
export interface GhosttyCell {
  codepoint: number; // u32 (Unicode codepoint - first codepoint of grapheme)
  fg_r: number; // u8 (foreground red)
  fg_g: number; // u8 (foreground green)
  fg_b: number; // u8 (foreground blue)
  bg_r: number; // u8 (background red)
  bg_g: number; // u8 (background green)
  bg_b: number; // u8 (background blue)
  flags: number; // u8 (style flags bitfield)
  width: number; // u8 (character width: 1=normal, 2=wide, etc.)
  hyperlink_id: number; // u16 (0 = no link, >0 = hyperlink ID in set)
  grapheme_len: number; // u8 (number of extra codepoints beyond first)
}

/** The style bits of `GhosttyCell.flags`, which the renderer draws. */
export enum CellFlags {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  UNDERLINE = 1 << 2,
  STRIKETHROUGH = 1 << 3,
  INVERSE = 1 << 4,
  INVISIBLE = 1 << 5,
  BLINK = 1 << 6,
  FAINT = 1 << 7,
}
