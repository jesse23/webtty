// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal's event emitters (object): one per xterm-style `onX` event, disposed together
// when the terminal is (ADR 061).

import type { DesktopNotification, SearchState } from '../engine/engine-types';
import { EventEmitter } from '../event-emitter';

/** The emitters behind Terminal's `onX` events; the terminal and its controllers fire them. */
export class TerminalEmitters {
  readonly data = new EventEmitter<string>();
  readonly resize = new EventEmitter<{ cols: number; rows: number }>();
  readonly bell = new EventEmitter<void>();
  readonly titleChange = new EventEmitter<string>();
  readonly scroll = new EventEmitter<number>();
  readonly pasteRequest = new EventEmitter<void>();
  readonly clipboardWrite = new EventEmitter<string>();
  readonly desktopNotification = new EventEmitter<DesktopNotification>();
  readonly findChange = new EventEmitter<SearchState>();
  readonly updatePainted = new EventEmitter<void>();

  /** Drops every listener of every emitter. */
  dispose(): void {
    this.data.dispose();
    this.resize.dispose();
    this.bell.dispose();
    this.titleChange.dispose();
    this.scroll.dispose();
    this.pasteRequest.dispose();
    this.clipboardWrite.dispose();
    this.desktopNotification.dispose();
    this.findChange.dispose();
    this.updatePainted.dispose();
  }
}
