// `GET /api/config`: the client-safe view of the config file (ADR 009, ADR 062). A route
// handler; the config is loaded per request so an edited file applies on the next tab reload.
import type { Config } from '../../config';
import { toClientConfig } from '../../config';
import { sendJson } from '../http/respond';
import type { Route } from '../http/router';

/** What the config route needs: the loader, called once per request. */
export interface ConfigRouteDeps {
  loadConfig: () => Config;
}

/** The config route. Only the client keys leave the server; shell, host, logs and env stay. */
export function configRoutes(deps: ConfigRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/config',
      handle: ({ res }) => sendJson(res, 200, toClientConfig(deps.loadConfig())),
    },
  ];
}
