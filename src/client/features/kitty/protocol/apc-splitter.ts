// Splits APC sequences out of the PTY stream (object, pure, ADR 032): plain text goes on
// to the terminal, each `ESC _ ... ESC \` comes back whole, or as its start when it is
// over the size limit.

const ESC = '\x1b';

/**
 * A single APC is one chunk of at most 4096 base64 bytes per the spec, but
 * nothing stops a client sending one huge sequence. Bound what we buffer.
 */
export const MAX_APC_BYTES = 64 * 1024 * 1024;

// How much of the start of an APC is kept when it is too big to keep whole:
// enough for the control keys, so the command can still be answered.
const HEAD_BYTES = 4096;

// What ends an APC: ST (`ESC \`), or CAN / SUB, which cancel a control string.
const CAN = '\x18';
const SUB = '\x1a';
const APC_STOP = new RegExp(`[${ESC}${CAN}${SUB}]`, 'g');

/** A piece of the stream: text for the terminal, or one APC sequence's body. */
export type Segment =
  | { type: 'text'; text: string }
  // `overflow`: the sequence was over the size limit, so `body` is only its
  // start (the control keys), enough to answer with an error.
  | { type: 'apc'; body: string; overflow?: boolean };

/**
 * Splits a PTY stream into plain text and APC sequences (`ESC _ ... ESC \`).
 *
 * State survives across `feed()` calls: a WebSocket frame can end anywhere,
 * including between the `ESC` and `_` that open an APC, or between the `ESC`
 * and `\` that close it. A lone trailing `ESC` is therefore held back until
 * the next chunk says what it starts.
 *
 * A sequence over `maxBytes` is not buffered whole: its start is kept and the
 * rest is swallowed up to its terminator, so none of the payload reaches the
 * terminal as text. Like any control string it ends at ST, or at CAN / SUB,
 * which is the way out of one that is never terminated.
 */
export class ApcSplitter {
  private state: 'text' | 'esc' | 'apc' | 'apc-esc' = 'text';
  private parts: string[] = [];
  private head = '';
  private size = 0;
  private overflow = false;

  constructor(private maxBytes = MAX_APC_BYTES) {}

  feed(data: string): Segment[] {
    const out: Segment[] = [];
    let text = '';
    let i = 0;
    while (i < data.length) {
      if (this.state === 'text') {
        const esc = data.indexOf(ESC, i);
        if (esc < 0) {
          text += data.slice(i);
          break;
        }
        text += data.slice(i, esc);
        i = esc + 1;
        this.state = 'esc';
      } else if (this.state === 'esc') {
        if (data[i] === '_') {
          if (text) out.push({ type: 'text', text });
          text = '';
          this.begin();
          i++;
        } else {
          // Not an APC: give the held ESC back and reprocess this char.
          text += ESC;
          this.state = 'text';
        }
      } else if (this.state === 'apc') {
        APC_STOP.lastIndex = i;
        const stop = APC_STOP.exec(data);
        const end = stop ? stop.index : data.length;
        this.append(data.slice(i, end));
        i = end;
        if (stop) {
          i++;
          if (stop[0] === ESC) this.state = 'apc-esc';
          else this.reset(); // CAN / SUB: cancelled, nothing to deliver
        }
      } else if (data[i] === '\\') {
        // apc-esc: ESC \ closes the sequence.
        out.push(
          this.overflow
            ? { type: 'apc', body: this.head, overflow: true }
            : { type: 'apc', body: this.parts.join('') },
        );
        this.reset();
        i++;
      } else {
        // ESC not followed by `\` inside an APC: malformed. Drop the APC and
        // treat the ESC as the start of a fresh sequence.
        this.reset();
        this.state = 'esc';
      }
    }
    if (text) out.push({ type: 'text', text });
    return out;
  }

  private begin(): void {
    this.reset();
    this.state = 'apc';
  }

  private append(s: string): void {
    if (!s) return;
    if (this.head.length < HEAD_BYTES) this.head += s.slice(0, HEAD_BYTES - this.head.length);
    if (this.overflow) return;
    this.size += s.length;
    if (this.size > this.maxBytes) {
      this.overflow = true;
      this.parts = [];
      return;
    }
    this.parts.push(s);
  }

  private reset(): void {
    this.state = 'text';
    this.parts = [];
    this.head = '';
    this.size = 0;
    this.overflow = false;
  }
}
