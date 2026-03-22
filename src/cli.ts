import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 2346;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const command = process.argv[2];

if (command === 'start') {
  const isTs = __filename.endsWith('.ts');
  const serverEntry = path.resolve(__dirname, isTs ? 'server.ts' : 'server.js');
  if (!fs.existsSync(serverEntry)) {
    console.error(`wtty: server entry not found at ${serverEntry}`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  console.log('wtty started');
} else if (command === 'stop') {
  try {
    const res = await fetch(`${BASE_URL}/api/server/stop`, { method: 'POST' });
    if (res.ok) {
      console.log('wtty stopped');
    } else {
      console.error(`wtty stop failed (status: ${res.status})`);
      process.exit(1);
    }
  } catch {
    console.log('wtty is not running');
  }
} else {
  console.error('Usage: wtty start | wtty stop');
  process.exit(1);
}
