// The error a kitty graphics command is refused with (object, ADR 032): a protocol code
// such as EINVAL or ENOENT and the message the reply carries after it.

/** A refusal the reply reports as `<code>:<message>`; any other error is answered EBADF. */
export class KittyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
