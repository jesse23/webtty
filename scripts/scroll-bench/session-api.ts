// The webtty server calls the benchmark makes: create a fresh session for one run, the
// page URL that opens it, and delete it afterwards (POST /api/sessions, GET /s/:id and
// DELETE /api/sessions/:id, ADR 062; service over Bun's global fetch).

/** A session the benchmark created on one server. */
export interface BenchSession {
  base: string;
  id: string;
  /** The page that opens the session in a browser tab. */
  url: string;
}

/** A session ID for one run: valid for the server (`[a-z0-9-_.]`) and unlikely to clash. */
export function benchSessionId(parts: readonly (string | number)[], now = Date.now()): string {
  const slug = parts
    .map((p) =>
      String(p)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
    )
    .join('-')
    .slice(0, 48);
  return `bench-${slug}-${now.toString(36)}`.replace(/-+/g, '-');
}

/** Creates the session `id` on the server at `base`. */
export async function createSession(base: string, id: string): Promise<BenchSession> {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (res.status !== 201) {
    throw new Error(`POST ${base}/api/sessions: ${res.status} ${await res.text()}`);
  }
  return { base, id, url: `${base}/s/${encodeURIComponent(id)}` };
}

/** Deletes the session, ending its shell and whatever runs in it; a missing one is fine. */
export async function deleteSession(session: BenchSession): Promise<void> {
  const api = `${session.base}/api/sessions/${encodeURIComponent(session.id)}`;
  const res = await fetch(api, { method: 'DELETE' });
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`DELETE ${api}: ${res.status}`);
  }
}
