import { describe, expect, test } from 'bun:test';
import { Scratch, type ScratchAllocator } from '../../ghostty-web/engine/scratch';

// The scratch allocator on a fake wasm allocator: slot layout, alignment and its one free.

function fakeAllocator(address: number) {
  const calls: string[] = [];
  const ex: ScratchAllocator = {
    ghostty_wasm_alloc: (len) => {
      calls.push(`alloc ${len}`);
      return address;
    },
    ghostty_wasm_free: (ptr, len) => {
      calls.push(`free ${ptr} ${len}`);
    },
  };
  return { ex, calls };
}

describe('Scratch', () => {
  test('lays the slots out in order, each at its alignment, from an 8-aligned base', () => {
    const { ex, calls } = fakeAllocator(1003);
    const { at } = Scratch.create(ex, { a: [1, 1], b: [4, 4], c: [8, 8], d: [2, 2] });
    // a at 0, b at 4, c at 8, d at 16: 18 bytes, plus 8 to align the base.
    expect(calls).toEqual(['alloc 26']);
    expect(at).toEqual({ a: 1008, b: 1012, c: 1016, d: 1024 });
  });

  test('frees the allocation it made, at the raw address', () => {
    const { ex, calls } = fakeAllocator(1003);
    const { scratch } = Scratch.create(ex, { a: [4, 4] });
    scratch.free();
    expect(calls).toEqual(['alloc 12', 'free 1003 12']);
    expect(scratch.base).toBe(1003);
    expect(scratch.len).toBe(12);
  });

  test('throws when the wasm is out of memory', () => {
    const { ex } = fakeAllocator(0);
    expect(() => Scratch.create(ex, { a: [4, 4] })).toThrow('libghostty-vt: out of memory');
  });
});
