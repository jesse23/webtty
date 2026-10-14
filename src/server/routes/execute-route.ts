// `POST /s/:id/execute` with `{cmd, args, stdin?}`: runs the command in the session's base
// directory with the config's env and streams it back as NDJSON (ADR 062). A route handler;
// the process work is run-command.ts.
import type { Config } from '../../config';
import { readJsonOrReply } from '../http/request-body';
import { sendText } from '../http/respond';
import type { Route } from '../http/router';
import type { SessionStore } from '../sessions/session-store';
import { runCommand, type SpawnFn } from './run-command';
import { runningSessionOrReply } from './running-session';

/** What the execute route needs. */
export interface ExecuteRouteDeps {
  store: SessionStore;
  /** Read per command, so the env follows the config file. */
  loadConfig: () => Config;
  /** The child-process spawner; node's when omitted. */
  spawn?: SpawnFn;
}

/** The execute route. */
export function executeRoutes(deps: ExecuteRouteDeps): Route[] {
  return [
    {
      method: 'POST',
      path: /^\/s\/([^/]+)\/execute$/,
      handle: async ({ req, res, params }) => {
        const session = runningSessionOrReply(req, res, deps.store, params[0]);
        if (!session) return;
        const read = await readJsonOrReply(req, res);
        if (!read) return;
        const { cmd, args, stdin } = read.value as {
          cmd?: unknown;
          args?: unknown;
          stdin?: unknown;
        };
        if (typeof cmd !== 'string' || cmd.length === 0) {
          sendText(res, 400, 'invalid body');
          return;
        }
        if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
          sendText(res, 400, 'invalid body');
          return;
        }
        const options = {
          cmd,
          args: args as string[],
          stdin: typeof stdin === 'string' ? stdin : undefined,
          cwd: session.baseDir,
          env: () => ({ ...process.env, ...deps.loadConfig().env }),
        };
        runCommand(req, res, options, deps.spawn);
      },
    },
  ];
}
