// webtty (ADR 049, ADR 061), not from upstream.
// The mouse encoder binding (object): wraps one libghostty-vt mouse encoder and its
// event, made on the first report, turning mouse input into the report bytes for the
// app's tracking mode and format. Not to be confused with input/mouse-report.ts.

import type { EngineContext } from './engine-context';
import type { MouseGeometry, MouseInput } from './engine-types';
import type { OfficialLayout } from './official-layout';

/** Room for one mouse report; the longest, SGR-pixels, is under 32 bytes. */
export const MOUSE_REPORT_MAX = 64;

/**
 * The modes that set the mouse encoder's tracking mode and format: X10, normal, button,
 * any-event tracking, and the UTF-8, SGR, urxvt and SGR-pixels formats.
 */
export const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016];

/** The scratch slots the mouse encoder binding declares on the shared context. */
export function mouseEncoderSlots(L: OfficialLayout) {
  return {
    mouseSize: [L.mouse.size, 8],
    mousePos: [L.mouse.positionSize, 8],
    mouseOut: [MOUSE_REPORT_MAX, 8],
  } as const;
}

/** The names of the mouse encoder binding's scratch slots. */
export type MouseEncoderSlot = keyof ReturnType<typeof mouseEncoderSlots>;

/** The geometry fields, in the order their key joins them. */
function geometryKey(g: MouseGeometry): string {
  return [
    g.screenWidth,
    g.screenHeight,
    g.cellWidth,
    g.cellHeight,
    g.paddingTop,
    g.paddingRight,
    g.paddingBottom,
    g.paddingLeft,
  ].join(',');
}

/** Mouse reports through Ghostty's encoder (ADR 049). */
export class MouseEncoderBinding {
  private readonly ctx: EngineContext<MouseEncoderSlot>;
  // Encoder and event, made on the first report. `modes` is the MOUSE_MODES bitmask the
  // encoder was last set from; `geometry` the last size, as its key.
  private encoder = 0;
  private event = 0;
  private modes = -1;
  private geometry = '';

  constructor(ctx: EngineContext<MouseEncoderSlot>) {
    this.ctx = ctx;
  }

  /** Sets the screen and cell size reports are computed from; unchanged sizes are skipped. */
  setMouseGeometry(g: MouseGeometry): void {
    // Setting the size clears the encoder's last cell, so only a change is set.
    const key = geometryKey(g);
    if (key === this.geometry) return;
    const enc = this.ensureEncoder();
    const { at, L } = this.ctx;
    const M = L.mouse;
    const dv = this.ctx.dv();
    const u32 = (n: number) => Math.max(0, Math.round(n)) >>> 0;
    dv.setUint32(at.mouseSize + M.sizeField, M.size, true);
    dv.setUint32(at.mouseSize + M.screenWidth, u32(g.screenWidth), true);
    dv.setUint32(at.mouseSize + M.screenHeight, u32(g.screenHeight), true);
    // Ghostty ignores a zero cell size.
    dv.setUint32(at.mouseSize + M.cellWidth, Math.max(1, u32(g.cellWidth)), true);
    dv.setUint32(at.mouseSize + M.cellHeight, Math.max(1, u32(g.cellHeight)), true);
    dv.setUint32(at.mouseSize + M.paddingTop, u32(g.paddingTop), true);
    dv.setUint32(at.mouseSize + M.paddingRight, u32(g.paddingRight), true);
    dv.setUint32(at.mouseSize + M.paddingBottom, u32(g.paddingBottom), true);
    dv.setUint32(at.mouseSize + M.paddingLeft, u32(g.paddingLeft), true);
    this.ctx.ex.ghostty_mouse_encoder_setopt(enc, M.SIZE, at.mouseSize);
    this.geometry = key;
  }

  /** The report for one mouse input, empty when the app's mode reports nothing. */
  encodeMouse(input: MouseInput): Uint8Array {
    const { ex, at, L } = this.ctx;
    const M = L.mouse;
    const enc = this.ensureEncoder();
    this.syncModes(enc);
    this.ctx.u8()[at.u8] = input.anyButtonPressed ? 1 : 0;
    ex.ghostty_mouse_encoder_setopt(enc, M.ANY_BUTTON_PRESSED, at.u8);
    const ev = this.event;
    ex.ghostty_mouse_event_set_action(ev, M.action[input.action]);
    if (input.button) ex.ghostty_mouse_event_set_button(ev, M.button[input.button]);
    else ex.ghostty_mouse_event_clear_button(ev);
    ex.ghostty_mouse_event_set_mods(ev, input.mods);
    const dv = this.ctx.dv();
    dv.setFloat32(at.mousePos + M.x, input.x, true);
    dv.setFloat32(at.mousePos + M.y, input.y, true);
    ex.ghostty_mouse_event_set_position(ev, at.mousePos);
    const rc = ex.ghostty_mouse_encoder_encode(enc, ev, at.mouseOut, MOUSE_REPORT_MAX, at.u32);
    if (rc !== 0) return new Uint8Array(0);
    const n = this.ctx.dv().getUint32(at.u32, true);
    return this.ctx.u8().slice(at.mouseOut, at.mouseOut + n);
  }

  /** Frees the encoder and its event, if made. Safe to call again. */
  free(): void {
    const ex = this.ctx.ex;
    if (this.encoder) ex.ghostty_mouse_encoder_free(this.encoder);
    if (this.event) ex.ghostty_mouse_event_free(this.event);
    this.encoder = 0;
    this.event = 0;
  }

  /**
   * Sets the tracking mode and format from the terminal. That call also clears the
   * encoder's last cell, so it is made only when a mouse mode changed: per-cell motion
   * deduplication would otherwise reset on every event.
   */
  private syncModes(enc: number): void {
    let modes = 0;
    MOUSE_MODES.forEach((mode, i) => {
      if (this.ctx.getMode(mode)) modes |= 1 << i;
    });
    if (modes === this.modes) return;
    this.ctx.ex.ghostty_mouse_encoder_setopt_from_terminal(enc, this.ctx.term);
    this.modes = modes;
  }

  /** The mouse encoder, made with per-cell motion deduplication on, and its event. */
  private ensureEncoder(): number {
    if (this.encoder) return this.encoder;
    const { ex, vt, at } = this.ctx;
    this.encoder = vt.newHandle('mouse_encoder_new', (slot) => ex.ghostty_mouse_encoder_new(0, slot));
    this.event = vt.newHandle('mouse_event_new', (slot) => ex.ghostty_mouse_event_new(0, slot));
    this.ctx.u8()[at.u8] = 1;
    ex.ghostty_mouse_encoder_setopt(this.encoder, this.ctx.L.mouse.TRACK_LAST_CELL, at.u8);
    return this.encoder;
  }
}
