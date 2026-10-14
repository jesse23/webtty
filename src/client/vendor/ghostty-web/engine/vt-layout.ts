// webtty (ADR 041, ADR 042, ADR 061), not from upstream.
// The manifest reader (object + util): struct offsets, enum values and packed bit fields
// from the wasm's own `ghostty_type_json`, so nothing about the C layout is hard-coded.
// A missing name throws, so a pin bump that moves a field fails loudly.

import type { OfficialWasmExports } from './wasm-exports';

/** One packed bit field in the manifest, with the arms of a packed union field. */
export interface ManifestBits {
  lsb: number;
  width: number;
  arms?: Record<string, { bits: Record<string, ManifestBits> } | null>;
}

/** One type in the manifest: a struct, enum or packed value, with its size. */
export interface ManifestType {
  kind: string;
  size: number;
  fields?: Record<string, { offset: number; size: number }>;
  values?: Record<string, number>;
  bits?: Record<string, ManifestBits>;
}

/** A bit field of a packed value: shift right by `lsb`, then mask. */
export interface BitField {
  lsb: number;
  mask: number;
}

/** Reads the bits at `lsb` (masked) from a 64-bit value split into two u32 words. */
export function readBits(lo: number, hi: number, lsb: number, mask: number): number {
  if (lsb >= 32) return (hi >>> (lsb - 32)) & mask;
  if (lsb === 0) return lo & mask;
  return ((lo >>> lsb) | (hi << (32 - lsb))) & mask;
}

/** Struct layouts and enum values from the wasm's `ghostty_type_json` manifest. */
export class VtLayout {
  private readonly types: Record<string, ManifestType>;

  constructor(types: Record<string, ManifestType>) {
    this.types = types;
  }

  type(name: string): ManifestType {
    const t = this.types[name];
    if (!t) throw new Error(`libghostty-vt manifest has no type ${name}`);
    return t;
  }

  size(name: string): number {
    return this.type(name).size;
  }

  offset(type: string, field: string): number {
    const f = this.type(type).fields?.[field];
    if (!f) throw new Error(`libghostty-vt manifest has no field ${type}.${field}`);
    return f.offset;
  }

  enums(name: string): Record<string, number> {
    const values = this.type(name).values;
    if (!values) throw new Error(`libghostty-vt manifest type ${name} is not an enum`);
    return values;
  }

  value(name: string, key: string): number {
    const v = this.enums(name)[key];
    if (v === undefined) throw new Error(`libghostty-vt manifest has no value ${name}.${key}`);
    return v;
  }

  bitField(bits: Record<string, ManifestBits> | undefined, path: string): BitField {
    const b = bits?.[path];
    if (!b) throw new Error(`libghostty-vt manifest has no bit field ${path}`);
    return { lsb: b.lsb, mask: b.width >= 32 ? 0xffffffff : 2 ** b.width - 1 };
  }

  /** The bits of one arm of a packed union field, e.g. GhosttyCell.content.CODEPOINT. */
  armBits(type: string, field: string, arm: string): Record<string, ManifestBits> {
    const a = this.type(type).bits?.[field]?.arms?.[arm];
    if (!a) throw new Error(`libghostty-vt manifest has no arm ${type}.${field}.${arm}`);
    return a.bits;
  }
}

/**
 * Reads the wasm's `ghostty_type_json` manifest, a NUL-terminated JSON string in its
 * memory, into a layout. Called once per instance, so the decode is not cached.
 */
export function readVtLayout(
  ex: Pick<OfficialWasmExports, 'memory' | 'ghostty_type_json'>
): VtLayout {
  const p = ex.ghostty_type_json();
  const u8 = new Uint8Array(ex.memory.buffer);
  let end = p;
  while (u8[end] !== 0) end++;
  const manifest = JSON.parse(new TextDecoder().decode(u8.subarray(p, end))) as {
    types: Record<string, ManifestType>;
  };
  return new VtLayout(manifest.types);
}
