// Session identifiers: the accepted format and the random default (ADR 062). Pure
// utilities shared by the session routes; nothing here touches the session registry.

/** The accepted session ID: lowercase letters, digits and `-_.`, 1 to 64 characters. */
export const ID_RE = /^[a-z0-9\-_.]{1,64}$/;

/**
 * Returns `true` if `id` is a valid session identifier, so a route can reject an ID that
 * would not survive a URL path or the CLI before it creates or renames a session.
 *
 * @param id - The session ID to validate.
 * @returns `true` if the ID matches {@link ID_RE}, `false` otherwise.
 */
export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * Generates a random 8-character hex session ID, used when a client creates a session
 * without naming it.
 *
 * @returns A random session ID.
 */
export function generateId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}
