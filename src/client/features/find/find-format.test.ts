import { describe, expect, test } from 'bun:test';
import { countDescription, countLabel, type FindState } from './find-format';

const state = (total: number, selected: number | null): FindState => ({ total, selected });

describe('countLabel', () => {
  test.each([
    [state(0, null), '0/0'],
    [state(12, null), '0/12'],
    [state(12, 0), '1/12'],
    [state(12, 11), '12/12'],
  ])("shows Ghostty's selected/total, 0 before a match is selected: %o", (s, label) => {
    expect(countLabel(s)).toBe(label);
  });
});

describe('countDescription', () => {
  test.each([
    [state(0, null), 'No matches'],
    [state(1, null), '1 match'],
    [state(3, null), '3 matches'],
    [state(3, 1), 'Match 2 of 3'],
  ])('says the count in words for a screen reader: %o', (s, words) => {
    expect(countDescription(s)).toBe(words);
  });
});
