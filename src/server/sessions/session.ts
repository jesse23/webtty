// One terminal session: its shell's PTY, its clients and event subscribers, the scrollback
// ring replayed to a joining client, and its output pacer. An object that owns the PTY
// lifecycle, moved out of the WebSocket handler with its order kept exactly (ADR 062, ADR 048);
// the registry of sessions is SessionStore in session-store.ts.
import { homedir } from 'node:os';
import type { Config } from '../../config';
import type { PtyProcess, SpawnPty } from '../../pty';
import { type FlowSocket, OutputPacer } from '../output-pacer';
import { WS_CLOSE } from '../ws/close-codes';
import { InputModes } from './input-modes';
import { sessionBanner } from './session-banner';

/** What {@link Session.ensurePty} needs to start a shell, injected so tests need no real PTY. */
export interface PtySpawnDeps {
  /** Reads the config at spawn time, so an edited config file applies to the next shell (ADR 009). */
  loadConfig: () => Config;
  /** Spawns the shell: `spawnPty` from src/pty in production, a fake in tests. */
  spawnPty: SpawnPty;
  /** The package runner (`bunx` or `npx`) the banner tells the user to run. */
  runner: string;
}

/** The registry a session reports its shell's exit to; SessionStore implements it. */
export interface SessionExitHost {
  /** Unregisters the session, first thing on exit. */
  removeExited(id: string): void;
  /** Stops the server if no session is left; called once the clients' output is flushed. */
  notifyIfEmpty(): void;
}

/** A running (or recently created) terminal session; routes and sockets share it through SessionStore. */
export class Session {
  /** Unix timestamp (ms) when the session was created. */
  readonly createdAt = Date.now();
  /** The underlying PTY process, or `null` if no shell has been spawned yet (or it exited). */
  pty: PtyProcess | null = null;
  /** All currently connected PTY clients. */
  readonly clients = new Set<FlowSocket>();
  /** All currently connected event subscribers. */
  readonly subscribers = new Set<FlowSocket>();
  /** The last `config.scrollback` characters of output, replayed when a client joins. */
  scrollback = '';
  /** The input modes the output last set, restored ahead of the replay (ADR 070). */
  readonly inputModes = new InputModes();
  /** Paces PTY output to the clients by their acknowledgements (ADR 048). */
  readonly output = new OutputPacer(() => this.pty);

  /**
   * @param id - Unique session identifier; SessionStore.rename changes it.
   * @param baseDir - Working directory for the shell (default: the user's home).
   */
  constructor(
    public id: string,
    readonly baseDir: string = homedir(),
  ) {}

  /**
   * Adds a PTY client. `acks` is true for a client that connected with `?flow=1`; one
   * without it predates ADR 048 (a tab loaded before an upgrade) and is sent output unpaced.
   * Called before {@link ensurePty}, so the banner is paced like any other output.
   */
  attach(ws: FlowSocket, acks: boolean): void {
    this.clients.add(ws);
    this.output.add(ws, acks);
  }

  /** Removes a PTY client whose socket closed, dropping what was queued for it. */
  detach(ws: FlowSocket): void {
    this.clients.delete(ws);
    this.output.remove(ws);
  }

  /**
   * Greets a newly attached client. The first client spawns the shell and is sent the
   * banner, which starts the scrollback, then the shell is sent a newline so it prints a
   * prompt. A later client is sent the input modes the output has set (ADR 070), then the
   * scrollback, and only then resizes the PTY.
   *
   * @param ws - The client just passed to {@link attach}.
   * @param cols - The client's width, used for the spawn or the resize.
   * @param rows - The client's height.
   * @param deps - How to read the config and spawn the shell.
   * @param host - Told when the shell exits.
   */
  ensurePty(
    ws: FlowSocket,
    cols: number,
    rows: number,
    deps: PtySpawnDeps,
    host: SessionExitHost,
  ): void {
    if (this.pty) {
      const replay = this.inputModes.restore() + this.scrollback;
      if (replay) this.output.send(ws, replay);
      this.pty.resize(cols, rows);
      return;
    }
    const config = deps.loadConfig();
    const limit = config.scrollback;
    const pty = deps.spawnPty({
      shell: config.shell,
      cols,
      rows,
      term: config.term,
      colorTerm: config.colorTerm,
      cwd: this.baseDir,
      env: config.env,
    });
    this.pty = pty;
    // The per-chunk hot path: append to the ring, note the input modes (a scan that returns
    // at once for a chunk with no ESC), and hand the chunk to the pacer.
    pty.onData((data: string) => {
      this.scrollback = (this.scrollback + data).slice(-limit);
      this.inputModes.observe(data);
      this.output.broadcast(data);
    });
    pty.onExit(() => this.handleExit(host));

    const banner = sessionBanner(deps.runner);
    this.output.send(ws, banner);
    this.scrollback = banner;
    pty.write('\n');
  }

  /**
   * Kills the shell and closes every client and subscriber with `code`; the API's delete
   * and the server's shutdown use it.
   */
  close(code: number, reason: string): void {
    this.pty?.kill();
    for (const client of this.clients) client.close(code, reason);
    for (const sub of this.subscribers) sub.close(code, reason);
    this.subscribers.clear();
  }

  /** Sends one published event line to every open subscriber (`POST /api/sessions/:id/events`). */
  broadcastEvent(line: string): void {
    for (const sub of this.subscribers) {
      if (sub.readyState === sub.OPEN) sub.send(line);
    }
  }

  /** The shell exited: unregister, close the subscribers, then flush and close the clients. */
  private handleExit(host: SessionExitHost): void {
    host.removeExited(this.id);
    for (const sub of this.subscribers) {
      if (sub.readyState === sub.OPEN) sub.close(WS_CLOSE.SESSION_GONE, 'shell exited');
    }
    this.subscribers.clear();
    this.pty = null;
    // A client behind the output is sent what is queued for it before it is closed,
    // so the last lines the shell wrote are not lost (ADR 048).
    this.output.end(WS_CLOSE.SESSION_GONE, 'shell exited').then(() => {
      host.notifyIfEmpty();
    });
  }
}

/**
 * Returns a plain JSON-safe representation of a session for API responses.
 *
 * @param s - The session to serialize.
 * @returns A JSON-safe object with session ID, creation timestamp, connection status, and PTY PID (or `null` if no PTY has been spawned yet).
 */
export function sessionToJson(s: Session) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    baseDir: s.baseDir,
    connected: s.clients.size > 0,
    pid: s.pty?.pid ?? null,
  };
}
