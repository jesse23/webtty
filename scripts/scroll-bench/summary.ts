// The benchmark's output: one result per (base, scenario, input, run), printed as a JSON
// line, and the markdown summary table of each kind's medians over the runs (util).

import type { Direction, InputName } from './inputs';
import { median, type PaintStats, type StreamStats } from './metrics';

/** What every result names: where and how it was measured. */
export interface ResultKey {
  /** The server's label, from `--base label=url`. */
  base: string;
  scenario: string;
  screen: 'alt' | 'normal';
  input: InputName;
  direction: Direction;
  run: number;
}

/** A scroll scenario's measures: frames recorded, blinks among them, paints and step. */
export interface ScrollResult extends ResultKey, PaintStats {
  kind: 'scroll';
  frames: number;
  blinks: number;
  avgStepPx: number;
}

/** A streaming scenario's measures (metrics.ts streamStats). */
export interface StreamResult extends ResultKey, StreamStats {
  kind: 'stream';
}

export type Result = ScrollResult | StreamResult;

/** One summary column: its heading and the result field it takes the median of. */
interface Column<R> {
  heading: string;
  field: keyof R & string;
}

const SCROLL_COLUMNS: Column<ScrollResult>[] = [
  { heading: 'blinks', field: 'blinks' },
  { heading: 'frames', field: 'frames' },
  { heading: 'paints/s', field: 'paintsPerSec' },
  { heading: 'gap p50 ms', field: 'gapMedian' },
  { heading: 'gap p90 ms', field: 'gapP90' },
  { heading: 'step px', field: 'avgStepPx' },
];

const STREAM_COLUMNS: Column<StreamResult>[] = [
  { heading: 'at bottom while scrolling', field: 'atBottomDuringScroll' },
  { heading: 'frames while scrolling', field: 'framesDuringScroll' },
  { heading: 'at bottom at rest', field: 'atBottomAtRest' },
  { heading: 'frames at rest', field: 'framesAtRest' },
  { heading: 'moved at rest', field: 'restFramesThatMoved' },
];

/** A result as the one-line JSON the benchmark prints. */
export function resultLine(result: Result): string {
  return JSON.stringify(result);
}

/** Rounds a median for the table: whole numbers stay whole, others keep one decimal. */
function cell(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function table<R extends Result>(title: string, results: readonly R[], columns: Column<R>[]) {
  const groups = new Map<string, R[]>();
  for (const r of results) {
    const key = `${r.scenario}\u0000${r.input}\u0000${r.base}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const head = ['scenario', 'input', 'base', 'runs', ...columns.map((c) => c.heading)];
  const lines = [
    `### ${title}`,
    '',
    `| ${head.join(' | ')} |`,
    `|${head.map(() => ' --- ').join('|')}|`,
  ];
  for (const group of groups.values()) {
    const { scenario, input, base } = group[0];
    const medians = columns.map((c) => cell(median(group.map((r) => r[c.field] as number))));
    lines.push(`| ${[scenario, input, base, group.length, ...medians].join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * The markdown summary: a table per kind that has results, one row per scenario, input
 * and base in the order they first came, each measure the median over the runs.
 */
export function summaryTable(results: readonly Result[]): string {
  const scroll = results.filter((r): r is ScrollResult => r.kind === 'scroll');
  const stream = results.filter((r): r is StreamResult => r.kind === 'stream');
  const parts: string[] = [];
  if (scroll.length) parts.push(table('Scroll (median over runs)', scroll, SCROLL_COLUMNS));
  if (stream.length) parts.push(table('Stream (median over runs)', stream, STREAM_COLUMNS));
  return parts.length ? parts.join('\n\n') : 'No results.';
}
