// `webtty mv <id> <new-id>` (and `move`, `rename`): rename a session. A command (ADR 063).
import { type RenameSessionResult, ServerUnreachableError } from '../api-client';
import type { CliDeps } from '../cli-deps';

/** Renames session `id` to `newId`; exits 1 on missing arguments or when the server refuses. */
export async function rename(
  { id, newId }: { id?: string; newId?: string },
  deps: Pick<CliDeps, 'client' | 'out' | 'err' | 'exit'>,
): Promise<void> {
  if (!id || !newId) {
    deps.err('webtty: rename requires two arguments: [id] [new-id]');
    deps.exit(1);
    return;
  }
  let result: RenameSessionResult;
  try {
    result = await deps.client.renameSession(id, newId);
  } catch (err) {
    if (!(err instanceof ServerUnreachableError)) throw err;
    deps.out('webtty is not running');
    deps.exit(1);
    return;
  }
  if (result.ok) {
    deps.out(`renamed ${id} → ${newId}`);
  } else if (result.status === 404) {
    deps.err(`session ${id} not found`);
    deps.exit(1);
  } else {
    const error = await result.error();
    deps.err(`webtty: ${error ?? `rename failed (${result.status})`}`);
    deps.exit(1);
  }
}
