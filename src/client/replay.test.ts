import { describe, expect, test } from 'bun:test';
import { DEFAULT_FLOW_LIMITS } from '../server/flow';
import { REPLAY_PIECE, REPLAY_QUIET_MS, ReplayWindow } from './replay';

describe('ReplayWindow', () => {
  test('is replay from the connect through its last piece', () => {
    const replay = new ReplayWindow();
    expect(replay.active).toBe(false);
    replay.connected();
    // Full pieces, the second one short of a surrogate pair, then the shorter last one.
    for (const chars of [REPLAY_PIECE, REPLAY_PIECE - 1, 10]) {
      replay.output(chars, 0);
      expect(replay.active).toBe(true);
      replay.parsed(0);
    }
    // The next message is live output, however soon it comes.
    replay.output(REPLAY_PIECE, 0);
    expect(replay.active).toBe(false);
  });

  test('a replay ending on a full piece is over when the output pauses after it', () => {
    const replay = new ReplayWindow();
    replay.connected();
    replay.output(REPLAY_PIECE, 0);
    // Slow to parse: the pause counts from the end of the parse.
    replay.parsed(REPLAY_QUIET_MS);
    replay.output(10, REPLAY_QUIET_MS * 2 - 1);
    expect(replay.active).toBe(true);
    replay.parsed(REPLAY_QUIET_MS * 2 - 1);
    // The short message ended it too: the next is live, as is one after a pause.
    replay.output(10, REPLAY_QUIET_MS * 2);
    expect(replay.active).toBe(false);

    const other = new ReplayWindow();
    other.connected();
    other.output(REPLAY_PIECE, 0);
    other.parsed(0);
    other.output(10, REPLAY_QUIET_MS);
    expect(other.active).toBe(false);
  });

  test('a reconnect replays again', () => {
    const replay = new ReplayWindow();
    replay.connected();
    replay.output(100, 0);
    replay.parsed(0);
    replay.output(10, 0);
    expect(replay.active).toBe(false);
    replay.connected();
    // The first message is the replay, however long after the connect it arrives.
    replay.output(10, REPLAY_QUIET_MS * 10);
    expect(replay.active).toBe(true);
  });

  test("the replay's piece size is the server's", () => {
    expect(REPLAY_PIECE).toBe(DEFAULT_FLOW_LIMITS.chunk);
  });
});
