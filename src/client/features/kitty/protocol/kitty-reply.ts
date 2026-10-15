// Builds the reply a kitty graphics command gets (util, pure, ADR 032), honouring the
// `q` quiet levels.

import { type KittyKeys, num } from './apc-command';

const ESC = '\x1b';

/**
 * Builds the reply for a command, or null when none must be sent: a command
 * without an image id/number gets no reply, `q=1` suppresses OK replies and
 * `q=2` suppresses everything.
 */
export function kittyReply(
  keys: KittyKeys,
  imageId: number,
  error?: { code: string; message: string },
): string | null {
  if (keys.i === undefined && keys.I === undefined) return null;
  const q = num(keys, 'q');
  if (q === 2 || (q === 1 && !error)) return null;
  const ids = [`i=${imageId}`];
  if (keys.I !== undefined) ids.push(`I=${keys.I}`);
  if (keys.p !== undefined) ids.push(`p=${keys.p}`);
  const status = error ? `${error.code}:${error.message}` : 'OK';
  return `${ESC}_G${ids.join(',')};${status}${ESC}\\`;
}
