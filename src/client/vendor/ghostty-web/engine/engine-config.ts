// webtty (ADR 042, ADR 046, ADR 049, ADR 061), not from upstream.
// The terminal's configuration (object): the scrollback limits, default modes, cursor
// and colours applied at creation, and the cursor blink that DECSCUSR sets, kept in
// Ghostty's mode 12 bit after every write.

import type { RenderStateCursor } from './cell-types';
import { scanCursorBlink } from './cursor-blink';
import type { EngineContext } from './engine-context';
import type { GhosttyTerminalConfig } from './engine-types';
import type { OfficialLayout } from './official-layout';

/** The scrollback byte ceiling under the line limit (ADR 046). */
export const SCROLLBACK_CEILING_BYTES = 32 * 1024 * 1024;
/** History in lines when the config gives none (ADR 046, ADR 047). */
export const DEFAULT_SCROLLBACK_LINES = 10000;
/** webtty's default foreground, used when the theme leaves it unset. */
export const FALLBACK_FOREGROUND = 0xcccccc;
/** webtty's default background, used when the theme leaves it unset. */
export const FALLBACK_BACKGROUND = 0x000000;
/** DEC private mode 12, AT&T cursor blink (ATT610). */
const MODE_CURSOR_BLINK = 12;
/** Grapheme clustering, on by default. */
const MODE_GRAPHEME_CLUSTER = 2027;

/** The scratch slots the config declares on the shared context. */
export function configSlots(L: OfficialLayout) {
  return {
    palette: [256 * L.colors.rgbSize, 8],
  } as const;
}

/** The names of the config's scratch slots. */
export type ConfigSlot = keyof ReturnType<typeof configSlots>;

/** Writes 0xRRGGBB as a GhosttyColorRgb at `ptr`. */
export function writeRgb(ctx: EngineContext, ptr: number, rgb: number): void {
  const u8 = ctx.u8();
  const C = ctx.L.colors;
  u8[ptr + C.r] = (rgb >>> 16) & 0xff;
  u8[ptr + C.g] = (rgb >>> 8) & 0xff;
  u8[ptr + C.b] = rgb & 0xff;
}

/** The configuration and the cursor blink of one terminal. */
export class EngineConfig {
  private readonly ctx: EngineContext<ConfigSlot>;
  // The blink DECSCUSR set, or the default while it has not set one; DEC mode 12 is
  // ignored, so Ghostty's mode bit is put back to it after every write (ADR 049).
  private blinkDefault = false;
  private blinkIsDefault = true;
  private blink = false;
  private blinkCarry = '';

  constructor(ctx: EngineContext<ConfigSlot>) {
    this.ctx = ctx;
  }

  /** Applies a new terminal's config: scrollback, default modes, cursor and colours. */
  apply(config: GhosttyTerminalConfig | undefined): void {
    const { L, at } = this.ctx;
    // Scrollback in lines under a 32 MiB ceiling (ADR 046). Whichever limit is reached
    // first applies. 0 bytes would disable scrollback and a NULL byte limit would
    // remove the ceiling, so neither is ever passed; NULL lines removes the line limit.
    const lines = config?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    this.ctx.dv().setUint32(at.u32, SCROLLBACK_CEILING_BYTES, true);
    this.ctx.setOption(L.opt.SCROLLBACK_MAX_BYTES, at.u32, 'SCROLLBACK_MAX_BYTES');
    if (lines > 0) this.ctx.dv().setUint32(at.u32, lines, true);
    this.ctx.setOption(L.opt.SCROLLBACK_MAX_LINES, lines > 0 ? at.u32 : 0, 'SCROLLBACK_MAX_LINES');

    // Grapheme clustering (mode 2027) on by default, so RIS keeps it.
    const dv = this.ctx.dv();
    dv.setUint16(at.mode + L.mode.mode, MODE_GRAPHEME_CLUSTER, true);
    dv.setUint8(at.mode + L.mode.value, 1);
    this.ctx.setOption(L.opt.MODE_DEFAULT, at.mode, 'MODE_DEFAULT 2027');

    // The configured cursor, which DECSCUSR Ps 0 and RIS restore (ADR 049).
    this.setDefaultCursor(config?.cursorStyle ?? 'block', config?.cursorBlink ?? false);
    this.applyColors(config);
  }

  /** The cursor DECSCUSR Ps 0 and RIS restore; shown at once while the app set none. */
  setDefaultCursor(style: RenderStateCursor['style'], blink: boolean): void {
    const { L, at } = this.ctx;
    this.ctx.dv().setInt32(at.u32, L.defaultCursorStyle[style], true);
    this.ctx.setOption(L.opt.DEFAULT_CURSOR_STYLE, at.u32, 'DEFAULT_CURSOR_STYLE');
    this.ctx.u8()[at.u8] = blink ? 1 : 0;
    this.ctx.setOption(L.opt.DEFAULT_CURSOR_BLINK, at.u8, 'DEFAULT_CURSOR_BLINK');
    this.blinkDefault = blink;
    if (this.blinkIsDefault) this.blink = blink;
    this.syncBlink();
    // The cursor is read from the render state, which only a content change refreshes.
    this.ctx.generation++;
  }

  /** Follows DECSCUSR in output that was just written, then puts mode 12 back. */
  afterWrite(text: string): void {
    const scan = scanCursorBlink(text, this.blinkCarry);
    this.blinkCarry = scan.carry;
    if (scan.ps !== undefined) {
      this.blinkIsDefault = scan.ps === 0;
      this.blink = scan.ps === 0 ? this.blinkDefault : scan.ps % 2 === 1;
    }
    this.syncBlink();
  }

  /**
   * Foreground and background are always both set: Ghostty's render state copies the
   * default colours only when both are set (render.zig `bg_fg`), otherwise it keeps
   * white on black and ignores the given colour, OSC 10/11 and DECSCNM. An unset one
   * falls back to webtty's default.
   */
  private applyColors(config: GhosttyTerminalConfig | undefined): void {
    const { L, at } = this.ctx;
    const setColor = (option: number, value: number, what: string) => {
      writeRgb(this.ctx, at.u32, value);
      this.ctx.setOption(option, at.u32, what);
    };
    setColor(L.opt.COLOR_FOREGROUND, config?.fgColor ?? FALLBACK_FOREGROUND, 'COLOR_FOREGROUND');
    setColor(L.opt.COLOR_BACKGROUND, config?.bgColor ?? FALLBACK_BACKGROUND, 'COLOR_BACKGROUND');
    if (!config) return;
    if (config.cursorColor !== undefined) {
      setColor(L.opt.COLOR_CURSOR, config.cursorColor, 'COLOR_CURSOR');
    }
    const palette = config.palette ?? [];
    const entries = palette
      .map((value, i) => ({ value, i }))
      .filter((e): e is { value: number; i: number } => e.i < 16 && e.value !== undefined);
    if (entries.length === 0) return;
    // Unset entries and 16-255 keep Ghostty's default palette.
    const rc = this.ctx.ex.ghostty_terminal_get(
      this.ctx.term,
      L.tdata.COLOR_PALETTE_DEFAULT,
      at.palette
    );
    if (rc !== 0) throw new Error(`libghostty-vt COLOR_PALETTE_DEFAULT failed: ${rc}`);
    for (const { value, i } of entries) writeRgb(this.ctx, at.palette + i * L.colors.rgbSize, value);
    this.ctx.setOption(L.opt.COLOR_PALETTE, at.palette, 'COLOR_PALETTE');
  }

  /**
   * Puts Ghostty's mode 12 bit, which its render state reports as the cursor blink,
   * back to the blink DECSCUSR set. Ghostty with `cursor-style-blink` set ignores mode
   * 12 (`setMode` in its `termio/stream_handler.zig`), and webtty's `cursorStyleBlink`
   * is always set, so a program's `CSI ? 12 l` (vim's `t_ve`) no longer stops the
   * blink for good. (webtty, ADR 049)
   */
  private syncBlink(): void {
    if (this.ctx.getMode(MODE_CURSOR_BLINK) === this.blink) return;
    const { at, L } = this.ctx;
    const M = L.mode;
    const dv = this.ctx.dv();
    dv.setUint16(at.mode + M.mode, MODE_CURSOR_BLINK, true);
    dv.setUint8(at.mode + M.value, this.blink ? 1 : 0);
    this.ctx.setOption(L.opt.MODE, at.mode, 'MODE 12');
  }
}
