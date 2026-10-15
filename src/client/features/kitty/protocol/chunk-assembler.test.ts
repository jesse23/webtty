import { describe, expect, test } from 'bun:test';
import { ChunkAssembler } from './chunk-assembler';

describe('ChunkAssembler', () => {
  test('single chunk returns immediately', () => {
    const a = new ChunkAssembler();
    expect(a.push({ keys: { a: 'T' }, payload: 'AAAA' })).toEqual({
      keys: { a: 'T' },
      data: 'AAAA',
    });
  });

  test('m=1 chunks are joined; first chunk keys win', () => {
    const a = new ChunkAssembler();
    expect(a.push({ keys: { a: 'T', i: '3', m: '1' }, payload: 'AAAA' })).toBeNull();
    expect(a.push({ keys: { m: '1' }, payload: 'BBBB' })).toBeNull();
    expect(a.push({ keys: { m: '0' }, payload: 'CCCC' })).toEqual({
      keys: { a: 'T', i: '3', m: '1' },
      data: 'AAAABBBBCCCC',
    });
  });

  test('assembler resets after a transmission completes', () => {
    const a = new ChunkAssembler();
    a.push({ keys: { m: '1' }, payload: 'A' });
    a.push({ keys: {}, payload: 'B' });
    expect(a.push({ keys: { i: '9' }, payload: 'Z' })).toEqual({ keys: { i: '9' }, data: 'Z' });
  });
});

describe('ChunkAssembler size cap', () => {
  test('chunks that add up past the cap are dropped and reported once, at the end', () => {
    const a = new ChunkAssembler(10);
    expect(a.push({ keys: { i: '4', m: '1' }, payload: 'AAAAAA' })).toBeNull();
    // 6 + 6 > 10: dropped here, the rest of the chunks are swallowed
    expect(a.push({ keys: { m: '1' }, payload: 'BBBBBB' })).toBeNull();
    expect(a.push({ keys: { m: '1' }, payload: 'C' })).toBeNull();
    expect(a.push({ keys: { m: '0' }, payload: 'D' })).toEqual({
      keys: { i: '4', m: '1' },
      data: '',
      tooBig: true,
    });
  });

  test('the cap applies when the overflow is on the final chunk', () => {
    const a = new ChunkAssembler(10);
    a.push({ keys: { i: '4', m: '1' }, payload: 'AAAAAA' });
    expect(a.push({ keys: { m: '0' }, payload: 'BBBBBB' })).toMatchObject({ tooBig: true });
  });

  test('a single oversized chunk is reported straight away', () => {
    const a = new ChunkAssembler(4);
    expect(a.push({ keys: { i: '2' }, payload: 'AAAAAAAA' })).toMatchObject({
      keys: { i: '2' },
      tooBig: true,
    });
  });

  test('a first chunk that is too big swallows the chunks that follow it', () => {
    const a = new ChunkAssembler(4);
    expect(a.push({ keys: { i: '2', m: '1' }, payload: 'AAAAAAAA' })).toBeNull();
    expect(a.push({ keys: { m: '1' }, payload: 'B' })).toBeNull();
    expect(a.push({ keys: { m: '0' }, payload: 'C' })).toMatchObject({ tooBig: true });
  });

  test('normal transmissions still work after an oversized one', () => {
    const a = new ChunkAssembler(4);
    a.push({ keys: { m: '0' }, payload: 'AAAAAAAA' });
    expect(a.push({ keys: { i: '9' }, payload: 'Z' })).toEqual({ keys: { i: '9' }, data: 'Z' });
  });
});

describe('ChunkAssembler.reject', () => {
  test('a rejected single command is reported as too big, with its keys', () => {
    expect(new ChunkAssembler().reject({ keys: { i: '3' }, payload: '' })).toEqual({
      keys: { i: '3' },
      data: '',
      tooBig: true,
    });
  });

  test('a rejected first chunk swallows the chunks after it and reports once at the end', () => {
    const a = new ChunkAssembler();
    expect(a.reject({ keys: { i: '3', m: '1' }, payload: '' })).toBeNull();
    expect(a.push({ keys: { m: '1' }, payload: 'AA' })).toBeNull();
    expect(a.push({ keys: { m: '0' }, payload: 'AA' })).toEqual({
      keys: { i: '3', m: '1' },
      data: '',
      tooBig: true,
    });
  });

  test('a rejected later chunk drops what was pending and answers for the first chunk', () => {
    const a = new ChunkAssembler();
    a.push({ keys: { i: '3', m: '1' }, payload: 'AAAA' });
    expect(a.reject({ keys: { m: '0' }, payload: '' })).toEqual({
      keys: { i: '3', m: '1' },
      data: '',
      tooBig: true,
    });
    // and the next transmission starts clean
    expect(a.push({ keys: { i: '4' }, payload: 'Z' })).toEqual({ keys: { i: '4' }, data: 'Z' });
  });
});
