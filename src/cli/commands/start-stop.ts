// `webtty start` and `webtty stop`: the background server's lifecycle, each a no-op with a
// message when the server is already in that state. Commands (ADR 063).
import type { CliDeps } from '../cli-deps';

/** Starts the server unless it is already running. */
export async function start(deps: Pick<CliDeps, 'client' | 'server' | 'out'>): Promise<void> {
  if (await deps.client.isRunning()) {
    deps.out('webtty is already running');
    return;
  }
  await deps.server.start();
  deps.out('webtty started');
}

/** Stops the server if it is running; exits 1 when it does not stop. */
export async function stop(
  deps: Pick<CliDeps, 'client' | 'server' | 'out' | 'err' | 'exit'>,
): Promise<void> {
  if (!(await deps.client.isRunning())) {
    deps.out('webtty is not running');
    return;
  }
  if (await deps.server.stop()) {
    deps.out('webtty stopped');
  } else {
    deps.err('webtty stop failed');
    deps.exit(1);
  }
}
