#!/usr/bin/env bun
// The scroll benchmark (CLI entry): for each server, scenario, input profile and run it
// creates a fresh session, opens it in an already running Chrome, starts the scenario's
// app, scrolls with the input while recording the screencast, prints one JSON line of
// numbers and deletes the session; then a markdown table of the medians over the runs.
//
// Start Chrome or Chromium yourself; the benchmark never launches or closes a browser:
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9333 --user-data-dir=/tmp/scroll-bench-chrome \
//     --window-size=1280,800 --no-first-run about:blank
//
// Start each webtty build to compare on its own port, then:
//
//   bun run bench:scroll --base before=http://localhost:3001 --base after=http://localhost:3002 \
//     --scenarios my-scenarios.json --inputs trackpad,wheel,trackpoint --runs 2
//
// Scenarios live in a JSON file of your own (scenarios.example.json shows the fields), so
// commands that resume a personal pi or Claude Code session stay out of the repo. A dark
// theme is assumed: the stream test finds the bottom by stream.sh's bright inverse bar.

import path from 'node:path';
import { parseBenchArgs, USAGE } from './bench-args';
import { type Cdp, connectCdp, sleep } from './cdp';
import { INPUT_PROFILES, type InputName } from './inputs';
import { measureScroll, measureStream, startScenario } from './measure';
import { loadScenarios, type Scenario } from './scenarios';
import { benchSessionId, createSession, deleteSession } from './session-api';
import { type Result, resultLine, summaryTable } from './summary';

/** Runs one scenario with one input in a fresh session and returns its result. */
async function runOne(
  cdp: Cdp,
  base: { label: string; url: string },
  scenario: Scenario,
  input: InputName,
  run: number,
): Promise<Result> {
  const id = benchSessionId([base.label, scenario.name, input, run]);
  const session = await createSession(base.url, id);
  try {
    await startScenario(cdp, session.url, scenario);
    const key = {
      base: base.label,
      scenario: scenario.name,
      screen: scenario.screen,
      input,
      direction: scenario.direction,
      run,
    };
    const profile = INPUT_PROFILES[input];
    if (scenario.kind === 'stream') {
      return { kind: 'stream', ...key, ...(await measureStream(cdp, profile, key.direction)) };
    }
    return { kind: 'scroll', ...key, ...(await measureScroll(cdp, profile, key.direction)) };
  } finally {
    await cdp.navigate('about:blank');
    await deleteSession(session);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const args = parseBenchArgs(argv);
  const scenarios = loadScenarios(args.scenariosFile, {
    repo: path.resolve(import.meta.dir, '../..'),
    bench: import.meta.dir,
  });
  const cdp = await connectCdp(args.cdpPort);
  const results: Result[] = [];
  try {
    for (const scenario of scenarios) {
      for (const input of args.inputs) {
        for (let run = 1; run <= args.runs; run++) {
          for (const base of args.bases) {
            const result = await runOne(cdp, base, scenario, input, run);
            results.push(result);
            console.log(resultLine(result));
            await sleep(500);
          }
        }
      }
    }
  } finally {
    cdp.close();
  }
  console.log(`\n${summaryTable(results)}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      console.error(USAGE);
      process.exit(1);
    },
  );
}
