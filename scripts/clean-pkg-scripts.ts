#!/usr/bin/env bun

import fs from 'node:fs';

const PKG_PATH = 'package.json';
const BACKUP_PATH = 'package.json.bak';
const command = process.argv[2];

if (command === 'strip') {
  const original = fs.readFileSync(PKG_PATH, 'utf8');
  fs.writeFileSync(BACKUP_PATH, original);

  const pkg = JSON.parse(original);
  delete pkg.scripts;
  delete pkg.devDependencies;
  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
} else if (command === 'restore') {
  try {
    const original = fs.readFileSync(BACKUP_PATH, 'utf8');
    fs.writeFileSync(PKG_PATH, original);
    fs.unlinkSync(BACKUP_PATH);
  } catch (err) {
    console.error(
      'Warning: failed to restore package.json from backup — restore manually if needed.',
      err,
    );
  }
} else {
  console.error('Usage: clean-pkg-scripts.ts strip | restore');
  process.exit(1);
}
