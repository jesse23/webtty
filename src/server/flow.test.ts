import { describe, expect, test } from 'bun:test';
import { FELL_BEHIND, type FlowLimits, type FlowSocket, OutputPacer } from './flow';

const LIMITS: FlowLimits = {
  highWater: 100,
  lowWater: 40,
  chunk: 30,
  maxPending: 1000,
  legacyBuffered: 500,
};

class FakeSocket implements FlowSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  messages: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.messages.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  get received(): string {
    return this.messages.join('');
  }
}

class FakePty {
  pauses = 0;
  resumes = 0;
  pause(): void {
    this.pauses++;
  }
  resume(): void {
    this.resumes++;
  }
}

function setup(pty: FakePty | null = new FakePty()) {
  const pacer = new OutputPacer(() => pty, LIMITS);
  return { pacer, pty };
}

describe('OutputPacer', () => {
  test('sends straight through under the high-water mark', () => {
    const { pacer } = setup();
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(50));
    pacer.broadcast('b'.repeat(40));
    expect(ws.messages).toEqual(['a'.repeat(50), 'b'.repeat(40)]);
  });

  test('queues output once a client reaches the high-water mark', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    pacer.broadcast('b');
    pacer.broadcast('c');
    expect(ws.messages).toEqual(['a'.repeat(100)]);
  });

  test('resumes below the low-water mark, in order and coalesced', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    for (const ch of 'bcdefgh') pacer.broadcast(ch.repeat(10));
    // Still above the low-water mark: nothing more is sent.
    pacer.ack(ws, 50);
    expect(ws.messages.length).toBe(1);
    pacer.ack(ws, 100);
    // Chunks of 10 coalesce into messages of up to 30 characters.
    expect(ws.messages.slice(1)).toEqual([
      'b'.repeat(10) + 'c'.repeat(10) + 'd'.repeat(10),
      'e'.repeat(10) + 'f'.repeat(10) + 'g'.repeat(10),
      'h'.repeat(10),
    ]);
    expect(ws.received).toBe(
      `${'a'.repeat(100)}${[...'bcdefgh'].map((c) => c.repeat(10)).join('')}`,
    );
  });

  test('a flush stops when the client blocks again', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    for (let i = 0; i < 20; i++) pacer.broadcast('x'.repeat(10));
    pacer.ack(ws, 100);
    // Messages of 30 go out until at least 100 are unacknowledged again.
    expect(ws.messages.slice(1).map((m) => m.length)).toEqual([30, 30, 30, 30]);
    pacer.ack(ws, 220);
    expect(ws.received.length).toBe(300);
  });

  test('never splits a queued chunk', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    pacer.broadcast('😀'.repeat(20)); // 40 code units, over the chunk size
    pacer.ack(ws, 100);
    expect(ws.messages[1]).toBe('😀'.repeat(20));
  });

  test('ignores acks beyond what was sent, repeated acks and acks going back', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    pacer.broadcast('b'.repeat(10));
    pacer.ack(ws, 1e9);
    expect(ws.received).toBe(`${'a'.repeat(100)}${'b'.repeat(10)}`);
    pacer.broadcast('c'.repeat(90));
    // 1e9 was capped at 100 sent, so 100 are unacknowledged again and the client blocks.
    pacer.broadcast('d');
    expect(ws.received.endsWith('d')).toBe(false);
    pacer.ack(ws, 10);
    pacer.ack(ws, Number.NaN);
    expect(ws.received.endsWith('d')).toBe(false);
    pacer.ack(ws, 200);
    expect(ws.received.endsWith('d')).toBe(true);
  });

  test('pauses the PTY while every client is blocked and resumes when one is not', () => {
    const { pacer, pty } = setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    pacer.add(a, true);
    pacer.add(b, true);
    pacer.send(a, 'x'.repeat(100));
    expect(pty?.pauses).toBe(0);
    pacer.send(b, 'y'.repeat(100));
    expect(pty?.pauses).toBe(1);
    expect(pacer.isPaused).toBe(true);
    pacer.ack(b, 100);
    expect(pty?.resumes).toBe(1);
    expect(pacer.isPaused).toBe(false);
  });

  test('resumes the PTY when the last blocked client leaves', () => {
    const { pacer, pty } = setup();
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('x'.repeat(100));
    expect(pacer.isPaused).toBe(true);
    pacer.remove(ws);
    expect(pacer.isPaused).toBe(false);
    expect(pty?.resumes).toBe(1);
  });

  test('a legacy client never pauses the PTY', () => {
    const { pacer, pty } = setup();
    const fast = new FakeSocket();
    const legacy = new FakeSocket();
    pacer.add(fast, true);
    pacer.add(legacy, false);
    pacer.broadcast('x'.repeat(300));
    expect(pty?.pauses).toBe(0);
    expect(legacy.received.length).toBe(300);
  });

  test('a PTY that cannot pause is left running', () => {
    const pacer = new OutputPacer(() => ({}), LIMITS);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('x'.repeat(100));
    expect(pacer.isPaused).toBe(false);
  });

  test('a legacy client is sent everything straight through', () => {
    const { pacer } = setup();
    const ws = new FakeSocket();
    pacer.add(ws, false);
    for (let i = 0; i < 10; i++) pacer.broadcast('z'.repeat(100));
    expect(ws.received.length).toBe(1000);
    expect(ws.closed).toBeNull();
  });

  test('a legacy client is closed once bufferedAmount passes the limit', () => {
    const { pacer } = setup();
    const ws = new FakeSocket();
    pacer.add(ws, false);
    ws.bufferedAmount = 501;
    pacer.broadcast('z');
    expect(ws.closed?.code).toBe(FELL_BEHIND);
    pacer.broadcast('after');
    expect(ws.received).toBe('z');
  });

  test('closes a client whose queue overflows and keeps serving the others', () => {
    const { pacer } = setup();
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    pacer.add(slow, true);
    pacer.add(fast, true);
    let sent = 0;
    for (let i = 0; i < 120; i++) {
      pacer.broadcast('q'.repeat(10));
      sent += 10;
      pacer.ack(fast, sent);
    }
    expect(slow.closed?.code).toBe(FELL_BEHIND);
    expect(fast.received.length).toBe(1200);
    expect(fast.closed).toBeNull();
  });

  test('skips a client that is no longer open', () => {
    const { pacer } = setup();
    const ws = new FakeSocket();
    pacer.add(ws, true);
    ws.readyState = 2;
    pacer.broadcast('x');
    expect(ws.messages).toEqual([]);
  });

  test('a slow client receives the whole stream byte for byte and in order', () => {
    const { pacer, pty } = setup();
    const slow = new FakeSocket();
    pacer.add(slow, true);
    let expected = '';
    let parsed = 0;
    let produced = 0;
    for (let step = 0; step < 100_000; step++) {
      // The PTY produces only while it is not paused.
      if (!pacer.isPaused && produced < 3000) {
        const line = `${String(produced++).padStart(5, '0')}\x1b[38;2;1;2;3m╳😀\r\n`;
        expected += line;
        pacer.broadcast(line);
      }
      // The client parses a few characters every few steps, and stalls for a while.
      if (step % 7 === 0 && !(step > 2000 && step < 6000)) {
        parsed = Math.min(slow.received.length, parsed + 25);
        pacer.ack(slow, parsed);
      }
      if (produced === 3000 && parsed === expected.length) break;
    }
    expect(produced).toBe(3000);
    expect(slow.received).toBe(expected);
    expect(slow.closed).toBeNull();
    expect(pty?.pauses).toBeGreaterThan(10);
    expect(pty?.resumes).toBe(pty?.pauses);
  });
});
