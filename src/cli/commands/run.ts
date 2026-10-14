// `webtty run <id> [cmd [args...]]`: without a command, warm a session up (server, session and
// PTY, no browser); with one, run it headless in the session and relay its output and exit code.
// A command in two functions, warmUp and exec (ADR 063).
import { type ExecuteResponse, ServerUnreachableError } from '../api-client';
import { sessionPageUrl } from '../browser-opener';
import type { CliDeps } from '../cli-deps';

/** The arguments of `run`; `cmd` undefined means warm-up. */
export interface RunArgs {
  id: string;
  cmd?: string;
  args?: string[];
}

/** Dispatches to {@link warmUp} or {@link exec}. */
export async function run({ id, cmd, args = [] }: RunArgs, deps: CliDeps): Promise<void> {
  if (!cmd) {
    await warmUp(id, deps);
    return;
  }
  await exec(id, cmd, args, deps);
}

/**
 * Starts the server if needed, ensures session `id`, starts its PTY by opening and closing its
 * socket, then prints the session URL. Exits 1 when the session or the PTY cannot start.
 */
export async function warmUp(
  id: string,
  deps: Pick<CliDeps, 'client' | 'server' | 'config' | 'out' | 'err' | 'exit'>,
): Promise<void> {
  if (!(await deps.client.isRunning())) {
    await deps.server.start();
  }

  const session = await deps.client.ensureSession(id);
  if ('error' in session) {
    deps.err(`webtty: ${session.error}`);
    deps.exit(1);
    return;
  }

  try {
    await deps.client.openPty(id);
  } catch (err) {
    deps.err(`webtty: failed to start PTY: ${(err as Error).message}`);
    deps.exit(1);
    return;
  }

  deps.out(sessionPageUrl(deps.config(), id));
}

/**
 * Runs `cmd args` in session `id`'s PTY environment, writing its stdout and stderr as they
 * stream in and exiting with its exit code. Exits 1 when the server, session or PTY is missing
 * or the stream ends without an exit message.
 */
export async function exec(
  id: string,
  cmd: string,
  args: string[],
  deps: Pick<CliDeps, 'client' | 'err' | 'write' | 'exit'>,
): Promise<void> {
  if (!(await deps.client.isRunning())) {
    deps.err('webtty: server is not running');
    deps.exit(1);
    return;
  }

  let response: ExecuteResponse;
  try {
    response = await deps.client.execute(id, cmd, args);
  } catch (err) {
    if (!(err instanceof ServerUnreachableError)) throw err;
    deps.err('webtty: server is not running');
    deps.exit(1);
    return;
  }

  const failure = executeFailure(response.status, id);
  if (failure || !response.ok || !response.messages) {
    deps.err(failure ?? `webtty: run failed (${response.status})`);
    deps.exit(1);
    return;
  }

  for await (const msg of response.messages) {
    if (msg.stream === 'stdout') deps.write.stdout(String(msg.data));
    else if (msg.stream === 'stderr') deps.write.stderr(String(msg.data));
    else if ('exit' in msg) {
      if (msg.error) deps.err(`webtty: ${msg.error}`);
      deps.exit((msg.exit as number) ?? 1);
      return;
    }
  }
  deps.err('webtty: connection closed unexpectedly');
  deps.exit(1);
}

/** The message for a status the server uses to refuse a run, or undefined. */
function executeFailure(status: number, id: string): string | undefined {
  if (status === 404) return `webtty: session not found: ${id}`;
  if (status === 409) return `webtty: PTY not running for session: ${id}`;
  return undefined;
}
