#!/usr/bin/env node
// Global launcher: run `coder` inside any project directory. The agent operates
// on that directory (process.cwd()), while the model + API key come from the
// app's shared config. Installed via `npm link` in the app directory.
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = resolve(appDir, 'src', 'cli.ts');
// Run tsx's JS entry directly with node instead of the .bin/tsx.cmd shim. This
// avoids needing shell:true, so user-supplied args are passed as a safe argv
// array (no shell escaping/injection concerns).
const tsx = resolve(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(process.execPath, [tsx, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(), // the project the user launched from — what the agent edits
});
child.on('exit', (code) => process.exit(code ?? 0));
