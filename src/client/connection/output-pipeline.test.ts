import { describe, expect, test } from 'bun:test';
import { createOutputHandler } from './output-pipeline';

describe('createOutputHandler', () => {
  test('replay.output → graphics.feed → replay.parsed → ack.parsed → smoothScroll.onOutput', () => {
    const calls: string[] = [];
    let time = 10;
    const handle = createOutputHandler({
      replay: {
        output: (chars, now) => calls.push(`replay.output ${chars} ${now}`),
        parsed: (now) => calls.push(`replay.parsed ${now}`),
      },
      graphics: {
        feed: (data) => {
          calls.push(`graphics.feed ${data}`);
          time = 25; // the parse takes time
        },
      },
      smoothScroll: { onOutput: () => calls.push('smoothScroll.onOutput') },
      now: () => time,
    });
    handle('hello', { parsed: (chars) => calls.push(`ack.parsed ${chars}`) });
    expect(calls).toEqual([
      'replay.output 5 10',
      'graphics.feed hello',
      'replay.parsed 25',
      'ack.parsed 5',
      'smoothScroll.onOutput',
    ]);
  });

  test('each message is acknowledged on the ack it came with', () => {
    const acked: string[] = [];
    const handle = createOutputHandler({
      replay: { output: () => {}, parsed: () => {} },
      graphics: { feed: () => {} },
      smoothScroll: { onOutput: () => {} },
      now: () => 0,
    });
    handle('ab', { parsed: (chars) => acked.push(`first ${chars}`) });
    handle('abc', { parsed: (chars) => acked.push(`second ${chars}`) });
    expect(acked).toEqual(['first 2', 'second 3']);
  });
});
