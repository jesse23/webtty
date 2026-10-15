// `webtty rm <id>`: remove a session, and stop the server when it was the last one. A command
// (ADR 063).
import { type RemoveSessionResult, ServerUnreachableError } from '../api-client';
import type { CliDeps } from '../cli-deps';

/** Removes session `id`; exits 1 without an id, when it is not found or the server refuses. */
export async function remove(
  { id }: { id?: string },
  deps: Pick<CliDeps, 'client' | 'server' | 'out' | 'err' | 'exit'>,
): Promise<void> {
  if (!id) {
    deps.err('webtty: rm requires a session id');
    deps.exit(1);
    return;
  }
  let result: RemoveSessionResult;
  try {
    result = await deps.client.removeSession(id);
  } catch (err) {
    if (!(err instanceof ServerUnreachableError)) throw err;
    deps.out('webtty is not running');
    deps.exit(1);
    return;
  }
  if (result.status === 204) {
    deps.out(`removed ${id}`);
    if (result.sessionsRemaining === '0') {
      await deps.server.stop();
      deps.out('no sessions remaining — webtty stopped');
    }
  } else if (result.status === 404) {
    deps.err(`session ${id} not found`);
    deps.exit(1);
  } else {
    deps.err(`webtty rm failed (status: ${result.status})`);
    deps.exit(1);
  }
}
