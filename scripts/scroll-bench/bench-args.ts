// The benchmark's command line: the servers to compare, the scenarios file, the input
// profiles, the runs and the CDP port, parsed and checked without side effects (util).

import { INPUT_NAMES, INPUT_PROFILES, type InputName, isInputName } from './inputs';

/** A server under test: the label results carry and its base URL. */
export interface BaseTarget {
  label: string;
  url: string;
}

/** What one benchmark invocation runs. */
export interface BenchArgs {
  bases: BaseTarget[];
  scenariosFile: string;
  inputs: InputName[];
  runs: number;
  cdpPort: number;
  /** A folder to save each run's frames in, to check a number against the pictures. */
  dump?: string;
}

/** The CDP port the README's Chrome command opens. */
export const DEFAULT_CDP_PORT = 9333;
export const DEFAULT_RUNS = 2;

export const USAGE = `usage: bun scripts/scroll-bench/bench.ts --base [label=]http://localhost:PORT ...
         --scenarios FILE [--inputs trackpad,wheel,trackpoint] [--runs N] [--cdp-port PORT]
         [--dump DIR]

  --base       a server to measure; repeat it to compare builds (label defaults to host:port;
               letters, digits and . _ : - only)
  --scenarios  a JSON array of scenarios (see scripts/scroll-bench/scenarios.example.json)
  --inputs     the input profiles to play, comma separated (default: all)
  --runs       runs of each scenario and input per server (default ${DEFAULT_RUNS})
  --cdp-port   the --remote-debugging-port of an already running Chrome (default ${DEFAULT_CDP_PORT})
  --dump       save each run's start screenshot, recorded frames and blink list under DIR

inputs:
${INPUT_NAMES.map((name) => `  ${name.padEnd(12)} ${INPUT_PROFILES[name].description}`).join('\n')}`;

/** What a label may hold, so it reads plainly in the JSON lines and the markdown table. */
const LABEL_RE = /^[A-Za-z0-9._:-]+$/;

/** Parses `label=url` or a bare URL, whose label is its host and port. */
export function parseBase(value: string): BaseTarget {
  const eq = value.indexOf('=');
  const label = eq > 0 ? value.slice(0, eq) : '';
  const raw = eq > 0 ? value.slice(eq + 1) : value;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--base: not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--base: must be http or https: ${raw}`);
  }
  const name = label || url.host;
  if (!LABEL_RE.test(name))
    throw new Error(`--base: a label is letters, digits and . _ : -: ${name}`);
  return { label: name, url: url.origin };
}

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag}: must be a whole number, 1 or more`);
  return n;
}

function parseInputs(value: string): InputName[] {
  const names = value.split(',').map((s) => s.trim());
  for (const name of names) {
    if (!isInputName(name)) {
      throw new Error(`--inputs: unknown input ${name}; one of ${INPUT_NAMES.join(', ')}`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error('--inputs: an input is repeated');
  return names as InputName[];
}

/** The servers in the order run `run` (from 1) measures them, rotated by one each run. */
export function basesForRun<T>(bases: readonly T[], run: number): T[] {
  const start = (run - 1) % bases.length;
  return [...bases.slice(start), ...bases.slice(0, start)];
}

/** Parses the flags after the script name; throws with the problem on a bad one. */
export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const bases: BaseTarget[] = [];
  let scenariosFile = '';
  let inputs = INPUT_NAMES;
  let runs = DEFAULT_RUNS;
  let cdpPort = DEFAULT_CDP_PORT;
  let dump: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag}: needs a value`);
    i++;
    if (flag === '--base') bases.push(parseBase(value));
    else if (flag === '--scenarios') scenariosFile = value;
    else if (flag === '--inputs') inputs = parseInputs(value);
    else if (flag === '--runs') runs = positiveInt(flag, value);
    else if (flag === '--cdp-port') cdpPort = positiveInt(flag, value);
    else if (flag === '--dump') dump = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (bases.length === 0) throw new Error('--base: give at least one server');
  if (!scenariosFile) throw new Error('--scenarios: give the scenarios file');
  const labels = new Set(bases.map((b) => b.label));
  if (labels.size !== bases.length) throw new Error('--base: labels must be unique');
  return { bases, scenariosFile, inputs, runs, cdpPort, ...(dump ? { dump } : {}) };
}
