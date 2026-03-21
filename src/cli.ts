import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 2346;
const BASE_URL = `http://localhost:${PORT}`;

const command = process.argv[2];

if (command === 'start') {
  const serverEntry = path.resolve(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  console.log('wtty started');
} else if (command === 'stop') {
  try {
    await fetch(`${BASE_URL}/api/server/stop`, { method: 'POST' });
    console.log('wtty stopped');
  } catch {
    console.log('wtty is not running');
  }
} else {
  console.error('Usage: wtty start | wtty stop');
  process.exit(1);
}
