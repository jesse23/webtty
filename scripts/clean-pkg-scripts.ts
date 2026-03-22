#!/usr/bin/env bun

import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

delete pkg.scripts;
delete pkg.devDependencies;

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
