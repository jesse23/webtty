import { describe, expect, test } from 'bun:test';
import {
  type Result,
  resultLine,
  type ScrollResult,
  type StreamResult,
  summaryTable,
} from './summary';

const scroll = (base: string, run: number, blinks: number, paintsPerSec: number): ScrollResult => ({
  kind: 'scroll',
  base,
  scenario: 'seq',
  screen: 'normal',
  input: 'trackpad',
  direction: 'up',
  run,
  frames: 140,
  blinks,
  paintsPerSec,
  gapMedian: 16,
  gapP90: 17,
  avgStepPx: 2.5,
});

const stream = (run: number, atBottomAtRest: number): StreamResult => ({
  kind: 'stream',
  base: 'after',
  scenario: 'stream',
  screen: 'normal',
  input: 'wheel',
  direction: 'up',
  run,
  framesDuringScroll: 90,
  atBottomDuringScroll: 2,
  framesAtRest: 80,
  atBottomAtRest,
  restFramesThatMoved: 0,
});

describe('resultLine', () => {
  test('is one line of JSON holding the whole result', () => {
    const line = resultLine(scroll('after', 1, 0, 60));
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(scroll('after', 1, 0, 60));
  });
});

describe('summaryTable', () => {
  test('one row per scenario, input and base, with the medians over runs', () => {
    const results: Result[] = [
      scroll('before', 1, 4, 30),
      scroll('after', 1, 0, 60),
      scroll('before', 2, 6, 31),
      scroll('after', 2, 1, 59.95),
      stream(1, 0),
      stream(2, 3),
    ];
    expect(summaryTable(results)).toBe(
      [
        '### Scroll (median over runs)',
        '',
        '| scenario | input | base | runs | blinks | frames | paints/s | gap p50 ms | gap p90 ms | step px |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| seq | trackpad | before | 2 | 5 | 140 | 30.5 | 16 | 17 | 2.5 |',
        '| seq | trackpad | after | 2 | 0.5 | 140 | 60 | 16 | 17 | 2.5 |',
        '',
        '### Stream (median over runs)',
        '',
        '| scenario | input | base | runs | at bottom while scrolling | frames while scrolling | at bottom at rest | frames at rest | moved at rest |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| stream | wheel | after | 2 | 2 | 90 | 1.5 | 80 | 0 |',
      ].join('\n'),
    );
  });

  test('says so when there are no results', () => {
    expect(summaryTable([])).toBe('No results.');
  });
});
