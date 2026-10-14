// webtty (ADR 042, ADR 061), not from upstream.
// The key encoder binding (object): wraps one libghostty-vt key encoder, turning
// ghostty-web key events into the bytes the app expects. Not to be confused with
// input/key-encoding.ts, the DOM key table lookup.

import type { KeyEncoderOption, KeyEvent } from '../input/key-types';
import type { EngineHost, KeyEncoder } from './engine-types';
import type { OfficialWasmExports } from './wasm-exports';

/**
 * Key encoder on the official wasm. ghostty-web's `Key`, `KeyAction` and
 * `KeyEncoderOption` values are translated by name to the official enums.
 */
export class OfficialKeyEncoder implements KeyEncoder {
  private readonly vt: EngineHost;
  private readonly ex: OfficialWasmExports;
  private encoder: number;
  private readonly value: number;
  private readonly written: number;

  constructor(vt: EngineHost) {
    this.vt = vt;
    this.ex = vt.ex;
    this.encoder = vt.newHandle('key_encoder_new', (slot) => this.ex.ghostty_key_encoder_new(0, slot));
    this.value = this.ex.ghostty_wasm_alloc(8);
    this.written = this.ex.ghostty_wasm_alloc(8);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const official = this.vt.encoderOptions.get(option);
    if (official === undefined) return;
    // Every option ghostty-web sets is a bool or the u8 kitty flags.
    new DataView(this.ex.memory.buffer).setUint8(
      this.value,
      typeof value === 'boolean' ? (value ? 1 : 0) : value
    );
    this.ex.ghostty_key_encoder_setopt(this.encoder, official, this.value);
  }

  encode(event: KeyEvent): Uint8Array {
    const ex = this.ex;
    const vt = this.vt;
    const ev = vt.newHandle('key_event_new', (slot) => ex.ghostty_key_event_new(0, slot));
    let utf8Ptr = 0;
    let utf8Len = 0;
    let buf = 0;
    let cap = 64;
    try {
      ex.ghostty_key_event_set_action(ev, vt.keyActions.get(event.action) ?? event.action);
      ex.ghostty_key_event_set_key(ev, vt.keys.get(event.key) ?? vt.unidentifiedKey);
      ex.ghostty_key_event_set_mods(ev, event.mods);
      if (event.utf8) {
        const bytes = new TextEncoder().encode(event.utf8);
        utf8Len = bytes.length;
        utf8Ptr = ex.ghostty_wasm_alloc(utf8Len);
        new Uint8Array(ex.memory.buffer).set(bytes, utf8Ptr);
        // The event does not copy the text; it stays allocated until after encode.
        ex.ghostty_key_event_set_utf8(ev, utf8Ptr, utf8Len);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        buf = ex.ghostty_wasm_alloc(cap);
        const rc = ex.ghostty_key_encoder_encode(this.encoder, ev, buf, cap, this.written);
        const n = new DataView(ex.memory.buffer).getUint32(this.written, true);
        if (rc === vt.L.result.OUT_OF_SPACE && attempt === 0) {
          ex.ghostty_wasm_free(buf, cap);
          buf = 0;
          cap = n;
          continue;
        }
        if (rc !== 0) throw new Error(`Failed to encode key: ${rc}`);
        return new Uint8Array(ex.memory.buffer, buf, n).slice();
      }
      throw new Error('Failed to encode key: out of space');
    } finally {
      if (buf) ex.ghostty_wasm_free(buf, cap);
      if (utf8Ptr) ex.ghostty_wasm_free(utf8Ptr, utf8Len);
      ex.ghostty_key_event_free(ev);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.ex.ghostty_key_encoder_free(this.encoder);
      this.ex.ghostty_wasm_free(this.value, 8);
      this.ex.ghostty_wasm_free(this.written, 8);
      this.encoder = 0;
    }
  }
}
