// Contract test: the close codes the client acts on are the server's own (ADR 060, ADR 062).
// Tests may cross the client/server line; the client source never imports the server.
import { describe, expect, test } from 'bun:test';
import { WS_CLOSE } from '../../server/ws/close-codes';
import { CLOSE_CODE } from './close-codes';

describe('CLOSE_CODE', () => {
  test.each(Object.keys(CLOSE_CODE) as (keyof typeof CLOSE_CODE)[])(
    "%s is the server's WS_CLOSE code",
    (name) => {
      expect(CLOSE_CODE[name]).toBe(WS_CLOSE[name]);
    },
  );

  test('the codes the tab closes on', () => {
    expect(CLOSE_CODE).toEqual({ SERVER_STOPPED: 1001, SESSION_GONE: 4001, FELL_BEHIND: 4003 });
  });
});
