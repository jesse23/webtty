// Tests for the PTY output pacer over fake sockets and a fake PTY: the high and low water
// marks, PTY pause, legacy clients, replay pacing and the end flush (ADR 048, ADR 062).
import { describe, expect, test } from 'bun:test';
import {
  FELL_BEHIND,
  type FlowLimits,
  type FlowSocket,
  OutputPacer,
  splitChunks,
} from './output-pacer';

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

  test('paces a replay in chunk-sized pieces and counts it against the window', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    const replay = 'r'.repeat(2500);
    pacer.send(ws, replay);
    // Pieces of 30 go out until 100 are unacknowledged; the rest is queued.
    expect(ws.messages.map((m) => m.length)).toEqual([30, 30, 30, 30]);
    // Over maxPending (1000), but a replay is allowed on top of it.
    expect(ws.closed).toBeNull();
    pacer.broadcast('live');
    let acked = 0;
    while (ws.received.length > acked) {
      acked = ws.received.length;
      pacer.ack(ws, acked);
    }
    expect(ws.received).toBe(`${replay}live`);
    expect(Math.max(...ws.messages.map((m) => m.length))).toBeLessThanOrEqual(30);
  });

  test('a replay still leaves maxPending for live output', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.send(ws, 'r'.repeat(2500));
    for (let i = 0; i < 99; i++) pacer.broadcast('x'.repeat(10));
    expect(ws.closed).toBeNull();
    pacer.broadcast('x'.repeat(20));
    expect(ws.closed?.code).toBe(FELL_BEHIND);
  });

  test("a replay's allowance ends once its queue drains", () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.send(ws, 'r'.repeat(2500));
    let acked = 0;
    while (ws.received.length > acked) {
      acked = ws.received.length;
      pacer.ack(ws, acked);
    }
    // Block the client again, then queue just over maxPending (1000) of live output.
    pacer.broadcast('x'.repeat(100));
    for (let i = 0; i < 100; i++) pacer.broadcast('x'.repeat(10));
    expect(ws.closed).toBeNull();
    pacer.broadcast('x'.repeat(10));
    expect(ws.closed?.code).toBe(FELL_BEHIND);
  });

  test('a legacy client gets a replay whole', () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, false);
    pacer.send(ws, 'r'.repeat(2500));
    expect(ws.messages).toEqual(['r'.repeat(2500)]);
  });

  test('splitChunks never cuts a surrogate pair', () => {
    const data = `a${'😀'.repeat(5)}`;
    const pieces = splitChunks(data, 4);
    expect(pieces).toEqual(['a😀', '😀😀', '😀😀']);
    expect(splitChunks('😀', 1)).toEqual(['\ud83d', '\ude00']);
    expect(splitChunks('', 4)).toEqual([]);
  });

  test('end closes at once a client with nothing queued', async () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    const legacy = new FakeSocket();
    pacer.add(ws, true);
    pacer.add(legacy, false);
    pacer.broadcast('x'.repeat(50));
    await pacer.end(4001, 'shell exited');
    expect(ws.closed).toEqual({ code: 4001, reason: 'shell exited' });
    expect(legacy.closed?.code).toBe(4001);
  });

  test('end sends the queue as acks allow, then closes', async () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    for (let i = 0; i < 25; i++) pacer.broadcast('b'.repeat(10));
    pacer.broadcast('END');
    let ended = false;
    const done = pacer.end(4001, 'shell exited', 60_000).then(() => {
      ended = true;
    });
    expect(ws.closed).toBeNull();
    pacer.ack(ws, 100);
    await Promise.resolve();
    expect(ended).toBe(false);
    expect(ws.closed).toBeNull();
    // Still blocked after the first flush.
    expect(ws.received.length).toBe(220);
    while (!ws.closed) pacer.ack(ws, ws.received.length);
    await done;
    expect(ws.received).toBe(`${'a'.repeat(100)}${'b'.repeat(250)}END`);
    expect(ws.closed?.code).toBe(4001);
  });

  test('end closes a client still behind after the timeout', async () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    pacer.broadcast('lost');
    await pacer.end(4001, 'shell exited', 10);
    expect(ws.closed?.code).toBe(4001);
    expect(ws.received).toBe('a'.repeat(100));
  });

  test('end waits for a client that keeps acknowledging', async () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    for (let i = 0; i < 50; i++) pacer.broadcast('c'.repeat(10));
    const done = pacer.end(4001, 'shell exited', 30);
    // Each ack comes within the timeout, though the flush takes longer than it.
    while (!ws.closed) {
      await Bun.sleep(15);
      pacer.ack(ws, ws.received.length);
    }
    await done;
    expect(ws.received.length).toBe(500);
    expect(ws.messages.length).toBeGreaterThan(8);
  });

  test('end resolves when a client behind closes on its own', async () => {
    const { pacer } = setup(null);
    const ws = new FakeSocket();
    pacer.add(ws, true);
    pacer.broadcast('a'.repeat(100));
    pacer.broadcast('b');
    const done = pacer.end(4001, 'shell exited', 60_000);
    pacer.remove(ws);
    await done;
    expect(ws.closed).toBeNull();
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
