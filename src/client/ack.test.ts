import { describe, expect, test } from 'bun:test';
import { ACK_EVERY, ACK_IDLE_MS, OutputAck } from './ack';

function setup() {
  const sent: { type: string; chars: number }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const ack = new OutputAck((m) => sent.push(JSON.parse(m)), {
    set: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clear: (h) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return { ack, sent, timers, fire };
}

describe('OutputAck', () => {
  test('acknowledges every ACK_EVERY characters with the running total', () => {
    const { ack, sent } = setup();
    for (let i = 0; i < 4; i++) ack.parsed(ACK_EVERY / 2);
    expect(sent).toEqual([
      { type: 'ack', chars: ACK_EVERY },
      { type: 'ack', chars: 2 * ACK_EVERY },
    ]);
  });

  test('a large message is acknowledged at once', () => {
    const { ack, sent } = setup();
    ack.parsed(3 * ACK_EVERY + 5);
    expect(sent).toEqual([{ type: 'ack', chars: 3 * ACK_EVERY + 5 }]);
  });

  test('acknowledges a smaller count after output stops', () => {
    const { ack, sent, timers, fire } = setup();
    ack.parsed(10);
    ack.parsed(20);
    expect(sent).toEqual([]);
    expect(timers.length).toBe(1);
    expect(timers[0].ms).toBe(ACK_IDLE_MS);
    fire();
    expect(sent).toEqual([{ type: 'ack', chars: 30 }]);
  });

  test('an acknowledgement by count cancels the idle one', () => {
    const { ack, sent, timers } = setup();
    ack.parsed(10);
    ack.parsed(ACK_EVERY);
    expect(sent).toEqual([{ type: 'ack', chars: ACK_EVERY + 10 }]);
    expect(timers.length).toBe(0);
  });

  test('sends nothing for empty output', () => {
    const { ack, sent, timers } = setup();
    ack.parsed(0);
    expect(timers.length).toBe(0);
    expect(sent).toEqual([]);
  });

  test('dispose stops a pending idle acknowledgement', () => {
    const { ack, sent, timers } = setup();
    ack.parsed(10);
    ack.dispose();
    expect(timers.length).toBe(0);
    expect(sent).toEqual([]);
  });
});
