import { describe, expect, test } from 'bun:test';
import { EventEmitter } from '../../ghostty-web/event-emitter';

describe('EventEmitter', () => {
  test('fires to every listener in subscription order', () => {
    const emitter = new EventEmitter<number>();
    const calls: string[] = [];
    emitter.event((n) => calls.push(`a${n}`));
    emitter.event((n) => calls.push(`b${n}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(calls).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  test('a subscription disposed stops only that listener, and a second dispose does nothing', () => {
    const emitter = new EventEmitter<string>();
    const calls: string[] = [];
    const a = emitter.event((s) => calls.push(`a:${s}`));
    emitter.event((s) => calls.push(`b:${s}`));
    a.dispose();
    a.dispose();
    emitter.fire('x');
    expect(calls).toEqual(['b:x']);
  });

  test('the same listener subscribed twice is called twice and unsubscribed once per dispose', () => {
    const emitter = new EventEmitter<void>();
    let calls = 0;
    const listener = () => calls++;
    const first = emitter.event(listener);
    emitter.event(listener);
    emitter.fire();
    expect(calls).toBe(2);
    first.dispose();
    emitter.fire();
    expect(calls).toBe(3);
  });

  test('a listener that unsubscribes itself during a fire makes the next one miss it', () => {
    // Upstream's behaviour, kept: fire walks the live list, which the splice shifts.
    const emitter = new EventEmitter<number>();
    const calls: string[] = [];
    const self = emitter.event((n) => {
      calls.push(`self${n}`);
      self.dispose();
    });
    emitter.event((n) => calls.push(`next${n}`));
    emitter.event((n) => calls.push(`last${n}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(calls).toEqual(['self1', 'last1', 'next2', 'last2']);
  });

  test('dispose drops every listener; a fire under way still reaches the rest', () => {
    const emitter = new EventEmitter<number>();
    const calls: string[] = [];
    emitter.event((n) => {
      calls.push(`a${n}`);
      emitter.dispose();
    });
    emitter.event((n) => calls.push(`b${n}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(calls).toEqual(['a1', 'b1']);
  });

  test('a subscription disposed after the emitter is disposed does nothing', () => {
    const emitter = new EventEmitter<number>();
    const sub = emitter.event(() => {});
    emitter.dispose();
    sub.dispose();
    const calls: number[] = [];
    emitter.event((n) => calls.push(n));
    emitter.fire(7);
    expect(calls).toEqual([7]);
  });
});
