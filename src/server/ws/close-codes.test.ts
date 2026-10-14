// Pins the WebSocket close codes on the wire, which the client depends on (ADR 048, ADR 062).
import { describe, expect, test } from 'bun:test';
import { WS_CLOSE } from './close-codes';

describe('WS_CLOSE', () => {
  test('pins the wire values the client depends on', () => {
    expect(WS_CLOSE).toEqual({
      SERVER_STOPPED: 1001,
      BAD_REQUEST: 1008,
      SESSION_GONE: 4001,
      PTY_NOT_RUNNING: 4002,
      FELL_BEHIND: 4003,
    });
  });
});
