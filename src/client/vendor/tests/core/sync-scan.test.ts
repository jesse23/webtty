import { describe, expect, test } from 'bun:test';
import { scanSyncBegin } from '../../ghostty-web/core/sync-scan';

// The synchronized-update scanner (ADR 067): which mode sets begin an update, and a
// begin split across output chunks.

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
