import type { Command } from 'commander';
import { BASE_URL, isServerRunning, openBrowser, startServer, stopServer } from './http';

export function registerCommands(program: Command): void {
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
    .command('ls')
    .description('List all sessions')
    .action(async () => {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/api/sessions`);
      } catch {
        console.log('webtty is not running');
        process.exit(1);
      }
      const sessions = (await res.json()) as Array<{
        id: string;
        connected: boolean;
        createdAt: number;
      }>;
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
    .command('run [id]')
    .description('Create or reuse a session and open it in the browser')
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
    .command('rm <id>')
    .description('Kill a session and its PTY')
    .action(async (id: string) => {
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
      } else if (res.status === 404) {
        console.error(`session ${id} not found`);
        process.exit(1);
      } else {
        console.error(`webtty rm failed (status: ${res.status})`);
        process.exit(1);
      }
    });

  program
    .command('rename <id> <new-id>')
    .description('Rename a session')
    .action(async (id: string, newId: string) => {
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
    .command('restart')
    .description('Restart the webtty server')
    .action(async () => {
      if (await isServerRunning()) {
        const ok = await stopServer();
        if (!ok) {
          console.error('webtty: failed to stop server');
          process.exit(1);
        }
      }
      await startServer();
      console.log('webtty restarted');
    });
}
