import { describe, expect, test } from 'bun:test';
import { FELL_BEHIND } from '../../server/flow';
import { CLOSE_CODE } from './close-codes';

describe('CLOSE_CODE', () => {
  test("fell-behind is the server's code (ADR 048)", () => {
    expect(CLOSE_CODE.FELL_BEHIND).toBe(FELL_BEHIND);
  });

  // The server's other codes are module-private on this branch; once its close-codes
  // module is exported (step C-F) these are pinned to it too.
  test('the codes the tab closes on', () => {
    expect(CLOSE_CODE.SERVER_STOPPED).toBe(1001);
    expect(CLOSE_CODE.SESSION_GONE).toBe(4001);
  });
});
