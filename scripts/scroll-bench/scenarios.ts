// Benchmark scenarios: what to run in a fresh session before scrolling, read from a JSON
// file given on the command line so personal commands (resuming one pi or Claude Code
// session) stay out of the repo. Parsing and checking are pure; scenarios.example.json
// shows the format; `note` is free text the benchmark ignores (util).

import fs from 'node:fs';
import type { Direction } from './inputs';

/** What a scenario measures: blinks and paints while scrolling, or the streaming test. */
export type ScenarioKind = 'scroll' | 'stream';

/** One app to start and scroll. */
export interface Scenario {
  name: string;
  kind: ScenarioKind;
  /** The command typed into the session's shell, after placeholder expansion. */
  command: string;
  /** Time for the app to start and draw, in ms. */
  waitMs: number;
  /** Press Enter once more after `waitMs` (a picker's first entry, as `pi -r` shows). */
  enter2: boolean;
  /** Time after the second Enter, in ms. */
  enter2WaitMs: number;
  direction: Direction;
  /** Which screen the app draws on; reported with the results. */
  screen: 'alt' | 'normal';
}

/** Values for the `{repo}` and `{bench}` placeholders in a command. */
export interface Placeholders {
  repo: string;
  bench: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const KNOWN_FIELDS = new Set([
  'name',
  'note',
  'kind',
  'command',
  'waitMs',
  'enter2',
  'enter2WaitMs',
  'direction',
  'screen',
]);

function oneOf<T extends string>(where: string, value: unknown, allowed: readonly T[], or: T): T {
  if (value === undefined) return or;
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`${where}: must be one of ${allowed.join(', ')}`);
}

function ms(where: string, value: unknown, or: number): number {
  if (value === undefined) return or;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${where}: must be a number of ms, 0 or more`);
}

/** Replaces `{repo}` and `{bench}` in `command`. */
export function expandCommand(command: string, vars: Placeholders): string {
  return command.replaceAll('{repo}', vars.repo).replaceAll('{bench}', vars.bench);
}

/** Checks one scenario entry and fills in its defaults; throws naming the bad field. */
export function parseScenario(entry: unknown, index: number, vars: Placeholders): Scenario {
  const where = `scenario ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${where}: must be an object`);
  }
  const raw = entry as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) throw new Error(`${where}: unknown field ${key}`);
  }
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) {
    throw new Error(`${where}: name must be lowercase letters, digits and dashes`);
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    throw new Error(`${where} (${raw.name}): command must be a non-empty string`);
  }
  if (raw.enter2 !== undefined && typeof raw.enter2 !== 'boolean') {
    throw new Error(`${where} (${raw.name}): enter2 must be true or false`);
  }
  const at = `${where} (${raw.name})`;
  return {
    name: raw.name,
    kind: oneOf(`${at} kind`, raw.kind, ['scroll', 'stream'], 'scroll'),
    command: expandCommand(raw.command, vars),
    waitMs: ms(`${at} waitMs`, raw.waitMs, 3000),
    enter2: raw.enter2 ?? false,
    enter2WaitMs: ms(`${at} enter2WaitMs`, raw.enter2WaitMs, 6000),
    direction: oneOf(`${at} direction`, raw.direction, ['up', 'down'], 'up'),
    screen: oneOf(`${at} screen`, raw.screen, ['alt', 'normal'], 'normal'),
  };
}

/** Checks a scenarios file's parsed JSON: an array of entries with unique names. */
export function parseScenarios(json: unknown, vars: Placeholders): Scenario[] {
  if (!Array.isArray(json)) throw new Error('scenarios: must be a JSON array');
  const scenarios = json.map((entry, i) => parseScenario(entry, i, vars));
  const seen = new Set<string>();
  for (const { name } of scenarios) {
    if (seen.has(name)) throw new Error(`scenarios: duplicate name ${name}`);
    seen.add(name);
  }
  return scenarios;
}

/** Reads and checks the scenarios file at `file`. */
export function loadScenarios(file: string, vars: Placeholders): Scenario[] {
  return parseScenarios(JSON.parse(fs.readFileSync(file, 'utf8')), vars);
}
