// `webtty ls [filter]`: print the sessions as a tab-separated table, optionally only those whose
// id contains `filter`. A command (ADR 063).
import { ServerUnreachableError, type SessionSummary } from '../api-client';
import type { CliDeps } from '../cli-deps';

/** Prints the session table, or `no sessions`; exits 1 when the server is not running. */
export async function list(
  { filter }: { filter?: string },
  deps: Pick<CliDeps, 'client' | 'out' | 'exit'>,
): Promise<void> {
  let all: SessionSummary[];
  try {
    all = await deps.client.listSessions();
  } catch (err) {
    if (!(err instanceof ServerUnreachableError)) throw err;
    deps.out('webtty is not running');
    deps.exit(1);
    return;
  }
  const sessions = filter ? all.filter((s) => s.id.includes(filter)) : all;
  if (sessions.length === 0) {
    deps.out('no sessions');
    return;
  }
  deps.out('id\t\t\tconnected\tcreated');
  for (const s of sessions) {
    const created = new Date(s.createdAt).toLocaleString();
    deps.out(`${s.id}\t\t\t${s.connected}\t\t${created}`);
  }
}
