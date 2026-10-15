// webtty (ADR 042, ADR 052, ADR 056, ADR 061), not from upstream.
// The terminal's effects (object): the libghostty-vt callbacks installed through
// `FnTable` (replies, bell, title, size and device-attribute reports, clipboard writes,
// desktop notifications) and the queue of what they reported, read after each write.

import { type InstalledFn, WasmValType } from '../fn-table';
import type { EngineContext } from './engine-context';
import type { DesktopNotification, TerminalEffects } from './engine-types';
import { isKittyKeyboardReply } from './kitty-keyboard-reply';
import type { OfficialLayout } from './official-layout';
import { isTextMime } from './text-mime';

/** The scratch slots the effects declare on the shared context. */
export function effectsSlots(L: OfficialLayout) {
  return {
    clipReply: [L.clipboardWrite.replySize, 8],
  } as const;
}

/** The names of the effects' scratch slots. */
export type EffectsSlot = keyof ReturnType<typeof effectsSlots>;

/** The two callbacks the terminal config can leave uninstalled. */
export interface EffectsOptions {
  clipboardWrite: boolean;
  desktopNotifications: boolean;
}

const I32 = WasmValType.I32;

/** A callback body; it returns a value only for the callbacks that return a bool. */
type Callback = (...args: number[]) => number | undefined;

/**
 * Everything the wasm reports through callbacks (ADR 042). The callbacks copy their
 * payload out before returning and never re-enter `vt_write`: the title is only flagged
 * there and read by `afterWrite`. They are released by `free()`, after the terminal.
 */
export class EngineEffects {
  private readonly ctx: EngineContext<EffectsSlot>;
  private readonly callbacks: InstalledFn[] = [];
  private readonly responses: Uint8Array[] = [];
  private bell = false;
  private titleChanged = false;
  private pendingTitle: string | null = null;
  private pendingClipboard: string | null = null;
  private pendingNotifications: DesktopNotification[] = [];

  constructor(ctx: EngineContext<EffectsSlot>, options: EffectsOptions) {
    this.ctx = ctx;
    this.installReplies();
    this.installReports();
    // CLIPBOARD_WRITE(terminal, userdata, write): left NULL with clipboardWrite off, so
    // Ghostty ignores OSC 52 and OSC 1337 Copy and refuses OSC 5522 writes (ADR 052).
    if (options.clipboardWrite) {
      this.install(this.ctx.L.opt.CLIPBOARD_WRITE, 'CLIPBOARD_WRITE', 3, false, (_t, _u, write) => {
        this.clipboardWrite(write);
        return undefined;
      });
    }
    if (options.desktopNotifications) this.installNotifications();
  }

  /** Reads what a write flagged but left for after it: the title. */
  afterWrite(): void {
    if (this.titleChanged) this.readTitle();
  }

  /** Whether a reply to the app is waiting. */
  hasResponse(): boolean {
    return this.responses.length > 0;
  }

  /** The waiting replies as one string, or null; the queue is emptied. */
  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    let total = 0;
    for (const r of this.responses) total += r.length;
    const all = new Uint8Array(total);
    let off = 0;
    for (const r of this.responses) {
      all.set(r, off);
      off += r.length;
    }
    this.responses.length = 0;
    return new TextDecoder().decode(all);
  }

  /** The bell, title, clipboard and notifications since the last read; then cleared. */
  readEffects(): TerminalEffects {
    const effects = {
      bell: this.bell,
      title: this.pendingTitle,
      clipboard: this.pendingClipboard,
      notifications: this.pendingNotifications,
    };
    this.bell = false;
    this.pendingTitle = null;
    this.pendingClipboard = null;
    this.pendingNotifications = [];
    return effects;
  }

  /**
   * Releases the callbacks' table slots; call only after the terminal is freed, when
   * nothing can call them (fn-table.ts rule 3). Safe to call again.
   */
  free(): void {
    for (const fn of this.callbacks) fn.release();
    this.callbacks.length = 0;
  }

  /** Installs `fn` with `params` i32 parameters and sets it as terminal option `option`. */
  private install(
    option: number,
    what: string,
    params: number,
    returnsBool: boolean,
    fn: Callback
  ): void {
    const installed = this.ctx.vt.fnTable.install(
      fn as (...args: number[]) => number | void,
      new Array(params).fill(I32),
      returnsBool ? [I32] : []
    );
    this.callbacks.push(installed);
    this.ctx.setOption(option, installed.index, what);
  }

  /** WRITE_PTY, BELL and TITLE_CHANGED: what output asks to send back or show. */
  private installReplies(): void {
    const opt = this.ctx.L.opt;
    // WRITE_PTY(terminal, userdata, data, len): copy the reply out before returning.
    // Each call carries one whole reply. The kitty keyboard query reply is dropped:
    // webtty's input handler never encodes keys with the kitty flags, so answering
    // `CSI ? u` would tell apps the protocol is on when it is not (ADR 042).
    this.install(opt.WRITE_PTY, 'WRITE_PTY', 4, false, (_t, _u, ptr, len) => {
      const reply = this.ctx.u8().slice(ptr, ptr + len);
      if (!isKittyKeyboardReply(reply)) this.responses.push(reply);
      return undefined;
    });
    this.install(opt.BELL, 'BELL', 2, false, () => {
      this.bell = true;
      return undefined;
    });
    // The title is read after vt_write returns (DATA_TITLE), not inside the callback.
    this.install(opt.TITLE_CHANGED, 'TITLE_CHANGED', 2, false, () => {
      this.titleChanged = true;
      return undefined;
    });
  }

  /** SIZE and DEVICE_ATTRIBUTES: the answers to size and DA queries. */
  private installReports(): void {
    const L = this.ctx.L;
    // SIZE(terminal, userdata, out): XTWINOPS 14/16/18/19 t and mode 2048 reports.
    this.install(L.opt.SIZE, 'SIZE', 3, true, (_t, _u, out) => {
      const Z = L.sizeReport;
      const dv = this.ctx.dv();
      dv.setUint16(out + Z.rows, this.ctx.rows, true);
      dv.setUint16(out + Z.columns, this.ctx.cols, true);
      dv.setUint32(out + Z.cellWidth, this.ctx.cellWidthPx, true);
      dv.setUint32(out + Z.cellHeight, this.ctx.cellHeightPx, true);
      return 1;
    });
    // DEVICE_ATTRIBUTES: ESC[?62;22c and ESC[>1;10;0c, the replies webtty gave on
    // the Coder wasm (without it, Ghostty's secondary DA is ESC[>1;0;0c).
    this.install(L.opt.DEVICE_ATTRIBUTES, 'DEVICE_ATTRIBUTES', 3, true, (_t, _u, out) => {
      const D = L.da;
      const dv = this.ctx.dv();
      const primary = out + D.primary;
      const secondary = out + D.secondary;
      dv.setUint16(primary + D.conformance, 62, true);
      dv.setUint16(primary + D.features, 22, true);
      dv.setUint32(primary + D.numFeatures, 1, true);
      dv.setUint16(secondary + D.deviceType, 1, true);
      dv.setUint16(secondary + D.firmware, 10, true);
      dv.setUint16(secondary + D.rom, 0, true);
      dv.setUint32(out + D.tertiary + D.unitId, 0, true);
      return 1;
    });
  }

  /**
   * DESKTOP_NOTIFICATION(terminal, userdata, notification): OSC 9 (but not ConEmu's
   * OSC 9;<n> forms, which Ghostty's parser takes first) and OSC 777;notify. The
   * strings are borrowed, so they are copied out here. Left NULL with
   * desktopNotifications off, so Ghostty ignores them (webtty, ADR 056).
   */
  private installNotifications(): void {
    const L = this.ctx.L;
    this.install(L.opt.DESKTOP_NOTIFICATION, 'DESKTOP_NOTIFICATION', 3, false, (_t, _u, n) => {
      const N = L.notification;
      // A sized struct: read only the fields its size covers.
      if (this.ctx.dv().getUint32(n + N.size, true) < N.bodyEnd) return undefined;
      const text = (ptr: number) => new TextDecoder().decode(this.stringAt(ptr));
      this.pendingNotifications.push({ title: text(n + N.title), body: text(n + N.body) });
      return undefined;
    });
  }

  /**
   * Takes one clipboard write (`GhosttyClipboardWrite`, already base64-decoded by
   * Ghostty) and answers it before returning, as the API requires. Only the standard
   * clipboard is written: the browser has no other, and Ghostty on macOS keeps `s` in
   * a private pasteboard and drops `p`. The text is the first plain-text
   * representation, decoded as UTF-8 with invalid bytes replaced (U+FFFD); no
   * representations is a clear, kept as `''`. The browser write happens later, after
   * `readEffects`, so success here means the write was accepted. (webtty, ADR 052)
   */
  private clipboardWrite(write: number): void {
    const C = this.ctx.L.clipboardWrite;
    const dv = this.ctx.dv();
    let result = C.UNSUPPORTED;
    if (dv.getInt32(write + C.location, true) === C.STANDARD) {
      const contents = dv.getUint32(write + C.contents, true);
      const count = dv.getUint32(write + C.contentsLen, true);
      if (count === 0) {
        this.pendingClipboard = '';
        result = C.SUCCESS;
      }
      for (let i = 0; i < count; i++) {
        const content = contents + i * C.contentSize;
        const mime = this.stringAt(content + C.mime);
        if (!isTextMime(new TextDecoder().decode(mime))) continue;
        this.pendingClipboard = new TextDecoder().decode(this.stringAt(content + C.data));
        result = C.SUCCESS;
        break;
      }
    }
    const reply = this.ctx.at.clipReply;
    const out = this.ctx.dv();
    new Uint8Array(this.ctx.ex.memory.buffer, reply, C.replySize).fill(0);
    out.setUint32(reply + C.replySizeField, C.replySize, true);
    out.setInt32(reply + C.replyResult, result, true);
    const fn = this.ctx.ex.__indirect_function_table.get(out.getUint32(write + C.reply, true)) as (
      write: number,
      reply: number
    ) => void;
    fn(write, reply);
  }

  /** A copy of the bytes a `GhosttyString` at `ptr` points to. */
  private stringAt(ptr: number): Uint8Array {
    const S = this.ctx.L.string;
    const dv = this.ctx.dv();
    const data = dv.getUint32(ptr + S.ptr, true);
    const len = dv.getUint32(ptr + S.len, true);
    return len === 0 ? new Uint8Array(0) : this.ctx.u8().slice(data, data + len);
  }

  /** Reads the title (DATA_TITLE) into the pending effects. */
  private readTitle(): void {
    this.titleChanged = false;
    const { at, L } = this.ctx;
    const S = L.string;
    if (this.ctx.ex.ghostty_terminal_get(this.ctx.term, L.tdata.TITLE, at.str) !== 0) return;
    const dv = this.ctx.dv();
    const ptr = dv.getUint32(at.str + S.ptr, true);
    const len = dv.getUint32(at.str + S.len, true);
    this.pendingTitle = len ? new TextDecoder().decode(this.ctx.u8().slice(ptr, ptr + len)) : '';
  }
}
