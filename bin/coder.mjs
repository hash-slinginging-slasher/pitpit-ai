#!/usr/bin/env node
// Global launcher: run `coder` inside any project directory. The agent operates
// on that directory (process.cwd()), while the model + API key come from the
// app's shared config. Installed via `npm link` in the app directory.
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = resolve(appDir, 'src', 'cli.ts');
const isWin = process.platform === 'win32';
const tsx = resolve(appDir, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');

const child = spawn(tsx, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(), // the project the user launched from — what the agent edits
  shell: isWin, // .cmd shims need a shell on Windows
});
child.on('exit', (code) => process.exit(code ?? 0));
