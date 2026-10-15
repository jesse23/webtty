// Runs one child process for `/s/:id/execute` and streams it to the HTTP reply as NDJSON:
// `{stream, data}` lines for stdout and stderr, then one `{exit}` line (ADR 062). A service;
// `spawn` is injected so tests drive a fake child.
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import type http from 'node:http';
import { sendText } from '../http/respond';

/** The `node:child_process` spawn signature run-command uses. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; windowsHide: boolean },
) => ChildProcess;

/** The command to run and where. */
export interface RunCommandOptions {
  cmd: string;
  args: string[];
  /** Written to the child's stdin before it is closed; stdin is closed either way. */
  stdin?: string;
  cwd: string;
  /** The child's environment, built inside the spawn guard so a failure there is a 500 too. */
  env: () => NodeJS.ProcessEnv;
}

/** One NDJSON line. */
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/**
 * Spawns `options.cmd` and streams it to `res`. A synchronous spawn failure answers
 * `500 spawn error: …`; an asynchronous one (such as ENOENT) ends the stream with a stderr
 * line and `{exit: 1, error, code?}`. The child is killed if the client goes away first.
 */
export function runCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: RunCommandOptions,
  spawn: SpawnFn = nodeSpawn,
): void {
  let child: ChildProcess;
  try {
    child = spawn(options.cmd, options.args, {
      env: options.env(),
      cwd: options.cwd,
      windowsHide: true,
    });
  } catch (err) {
    sendText(res, 500, `spawn error: ${String(err)}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
  });
  // Set once the exit line is written: an 'error' and a 'close' can both arrive.
  let done = false;
  child.on('error', (err) => {
    if (done) return;
    done = true;
    const msg = err.message;
    const code = (err as NodeJS.ErrnoException).code;
    res.write(line({ stream: 'stderr', data: `${msg}\n` }));
    res.write(line({ exit: 1, error: msg, ...(code ? { code } : {}) }));
    res.end();
  });
  if (typeof options.stdin === 'string') {
    child.stdin?.write(options.stdin);
  }
  child.stdin?.end();
  child.stdout?.on('data', (chunk: Buffer) => {
    res.write(line({ stream: 'stdout', data: chunk.toString() }));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    res.write(line({ stream: 'stderr', data: chunk.toString() }));
  });
  child.on('close', (code: number | null) => {
    if (done) return;
    done = true;
    res.write(line({ exit: code ?? 1 }));
    res.end();
  });
  req.on('close', () => {
    if (!done) child.kill();
  });
}
