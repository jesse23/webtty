// `webtty go [id]` (and `a`, `attach`, `open`, and a bare `webtty`): open a session in the
// browser, starting the server and creating the session when needed. A command (ADR 063).
import { sessionPageUrl } from '../browser-opener';
import type { CliDeps } from '../cli-deps';

/** The arguments of `go`. */
export interface GoArgs {
  /** The session to open; `main` when omitted. */
  id?: string;
  /** The working directory for a new session's shell (`--dir`). */
  baseDir?: string;
}

/** Opens (or creates) the session and prints its URL; exits 1 if it cannot be created. */
export async function go(
  { id = 'main', baseDir }: GoArgs,
  deps: Pick<CliDeps, 'client' | 'server' | 'config' | 'out' | 'err' | 'exit' | 'openBrowser'>,
): Promise<void> {
  if (!(await deps.client.isRunning())) {
    await deps.server.start();
  }

  const session = await deps.client.ensureSession(id, baseDir);
  if ('error' in session) {
    deps.err(`webtty: ${session.error}`);
    deps.exit(1);
    return;
  }

  const url = sessionPageUrl(deps.config(), session.id);
  deps.out(url);
  deps.openBrowser(url);
}
