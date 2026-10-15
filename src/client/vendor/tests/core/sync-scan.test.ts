import { describe, expect, test } from 'bun:test';
import { lastSyncEnd, scanSyncBegin, scanSyncBeginBytes } from '../../ghostty-web/core/sync-scan';

// The synchronized-update scanner (ADR 067): which mode sets begin an update, a begin
// split across output chunks, the byte scan agreeing with the string scan, and where the
// last update in a chunk ends.

describe('scanSyncBegin', () => {
  test.each([
    ['\x1b[?2026h', true],
    ['text\x1b[?2026hmore', true],
    ['\x1b[?25;2026h', true],
    ['\x1b[?2026;1049h', true],
    // The end, other modes and lookalikes
    ['\x1b[?2026l', false],
    ['\x1b[?12026h', false],
    ['\x1b[?20261h', false],
    ['\x1b[2026h', false],
    ['2026h', false],
    ['plain output', false],
  ])('%j begins an update: %p', (data, begun) => {
    expect(scanSyncBegin(data).begun).toBe(begun);
  });

  test('a begin split across chunks is found in the chunk that ends it, once', () => {
    let carry = '';
    const begins: boolean[] = [];
    for (const chunk of ['a\x1b', '[?20', '26', 'hb', 'c']) {
      const scan = scanSyncBegin(chunk, carry);
      carry = scan.carry;
      begins.push(scan.begun);
    }
    expect(begins).toEqual([false, false, false, true, false]);
    expect(carry).toBe('');
  });

  test('carries only an unfinished mode sequence, not a finished one or other text', () => {
    expect(scanSyncBegin('x\x1b[?2026').carry).toBe('\x1b[?2026');
    expect(scanSyncBegin('x\x1b[?2026h').carry).toBe('');
    expect(scanSyncBegin('x\x1b[31m').carry).toBe('');
    expect(scanSyncBegin(`\x1b[?${'1;'.repeat(20)}`).carry).toBe('');
  });
});

describe('scanSyncBeginBytes', () => {
  const encode = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

  test('finds what scanSyncBegin finds, and carries the same, over any chunking', () => {
    const output =
      'a\x1b[?25l\x1b[?2026hrow\x1b[2K\x1b[?2026l\x1b[?1;2;2026;1049hx\x1b[?12026h' +
      `\x1b[?${'2;'.repeat(20)}2026h\x1b[?2026h\x1b[31m\x1b[?2026`;
    let seed = 7;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 200; run++) {
      let text = { begun: false, carry: '' };
      let bytes = { begun: false, carry: '' };
      for (let at = 0; at < output.length; ) {
        const end = at + 1 + Math.floor(rng() * 12);
        const chunk = output.slice(at, end);
        at = end;
        text = scanSyncBegin(chunk, text.carry);
        bytes = scanSyncBeginBytes(encode(chunk), bytes.carry);
        expect(bytes).toEqual(text);
      }
    }
  });
});

describe('lastSyncEnd', () => {
  test.each([
    ['a\x1b[?2026lb', 9],
    ['\x1b[?2026h1\x1b[?2026l\x1b[?2026h2\x1b[?2026l', 34],
    ['\x1b[?2026h1\x1b[?2026l\x1b[?2026h2', 17],
    ['\x1b[?25;2026l', 11],
    // A begin, other modes and lookalikes end nothing
    ['\x1b[?2026h', -1],
    ['\x1b[?12026l', -1],
    ['2026l', -1],
    ['plain output', -1],
  ])('%j ends its last update at %p', (data, end) => {
    expect(lastSyncEnd(data)).toBe(end);
    expect(lastSyncEnd(new TextEncoder().encode(data))).toBe(end);
  });

  test('an index in bytes for bytes, past multi-byte characters', () => {
    const data = '─\x1b[?2026l';
    expect(lastSyncEnd(data)).toBe(9);
    expect(lastSyncEnd(new TextEncoder().encode(data))).toBe(11);
  });
});
