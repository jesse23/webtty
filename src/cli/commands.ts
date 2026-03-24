import * as childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { BASE_URL, isServerRunning, openBrowser, startServer, stopServer } from './http';

export function registerCommands(program: Command): void {
  program
    .command('at [id]')
    .alias('attach')
    .description('Attach to a new or existing session and open in browser')
    .action(async (id?: string) => {
      if (!(await isServerRunning())) {
        await startServer();
      }

      let sessionId: string;
      if (id) {
        const check = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}`);
        if (check.status === 200) {
          sessionId = id;
        } else {
          const res = await fetch(`${BASE_URL}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            console.error(`webtty: ${body.error ?? `failed to create session (${res.status})`}`);
            process.exit(1);
          }
          const session = (await res.json()) as { id: string };
          sessionId = session.id;
        }
      } else {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          console.error(`webtty: ${body.error ?? `failed to create session (${res.status})`}`);
          process.exit(1);
        }
        const session = (await res.json()) as { id: string };
        sessionId = session.id;
      }

      const url = `${BASE_URL}/s/${sessionId}`;
      console.log(url);
      openBrowser(url);
    });

  program
    .command('ls [id]')
    .alias('list')
    .description('List all sessions, or filter by id substring')
    .action(async (filter?: string) => {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/api/sessions`);
      } catch {
        console.log('webtty is not running');
        process.exit(1);
      }
      const all = (await res.json()) as Array<{
        id: string;
        connected: boolean;
        createdAt: number;
      }>;
      const sessions = filter ? all.filter((s) => s.id.includes(filter)) : all;
      if (sessions.length === 0) {
        console.log('no sessions');
        return;
      }
      console.log('id\t\t\tconnected\tcreated');
      for (const s of sessions) {
        const created = new Date(s.createdAt).toLocaleString();
        console.log(`${s.id}\t\t\t${s.connected}\t\t${created}`);
      }
    });

  program
    .command('rm [id]')
    .alias('remove')
    .description('Destroy a session')
    .action(async (id?: string) => {
      if (!id) {
        console.error('webtty: rm requires a session id');
        process.exit(1);
      }
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch {
        console.log('webtty is not running');
        process.exit(1);
      }
      if (res.status === 204) {
        console.log(`removed ${id}`);
        if (res.headers.get('x-sessions-remaining') === '0') {
          await stopServer();
          console.log('no sessions remaining — webtty stopped');
        }
      } else if (res.status === 404) {
        console.error(`session ${id} not found`);
        process.exit(1);
      } else {
        console.error(`webtty rm failed (status: ${res.status})`);
        process.exit(1);
      }
    });

  program
    .command('mv [id] [new-id]')
    .alias('rename')
    .description('Rename a session')
    .action(async (id?: string, newId?: string) => {
      if (!id || !newId) {
        console.error('webtty: rename requires two arguments: [id] [new-id]');
        process.exit(1);
      }
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: newId }),
        });
      } catch {
        console.log('webtty is not running');
        process.exit(1);
      }
      if (res.ok) {
        console.log(`renamed ${id} → ${newId}`);
      } else if (res.status === 404) {
        console.error(`session ${id} not found`);
        process.exit(1);
      } else {
        const body = (await res.json()) as { error?: string };
        console.error(`webtty: ${body.error ?? `rename failed (${res.status})`}`);
        process.exit(1);
      }
    });

  program
    .command('stop')
    .description('Stop the webtty server')
    .action(async () => {
      if (!(await isServerRunning())) {
        console.log('webtty is not running');
        return;
      }
      const ok = await stopServer();
      if (ok) {
        console.log('webtty stopped');
      } else {
        console.error('webtty stop failed');
        process.exit(1);
      }
    });

  program
    .command('start')
    .description('Start the webtty server')
    .action(async () => {
      if (await isServerRunning()) {
        console.log('webtty is already running');
        return;
      }
      await startServer();
      console.log('webtty started');
    });

  program
    .command('config')
    .description('Open the config file in $EDITOR')
    .action(() => {
      const configPath = path.join(os.homedir(), '.config', 'webtty', 'config.json');
      const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
      childProcess.spawnSync(editor, [configPath], { stdio: 'inherit' });
    });

  program
    .command('help')
    .description('Show help — all commands and options')
    .action(() => {
      program.outputHelp();
    });
}
