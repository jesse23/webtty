// Saves what one run recorded, so a number in the results can be checked against the
// pictures: the screen as the input started, every screencast frame and which of them
// counted as blinks (service over the file system).

import fs from 'node:fs';
import path from 'node:path';
import type { CastFrame } from './screencast';

/** What a run hands the dump: the start screenshot, its frames and the blink indices. */
export interface RunRecord {
  startPng: string;
  frames: readonly CastFrame[];
  blinks: readonly number[];
}

/** Writes `record` under `dir/id/`: start.png, frame-NNN.jpg and blinks.txt. */
export function writeDump(dir: string, id: string, record: RunRecord): void {
  const out = path.join(dir, id);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'start.png'), Buffer.from(record.startPng, 'base64'));
  record.frames.forEach((frame, i) => {
    const name = `frame-${String(i).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(out, name), Buffer.from(frame.jpeg, 'base64'));
  });
  fs.writeFileSync(path.join(out, 'blinks.txt'), `${record.blinks.join('\n')}\n`);
}
