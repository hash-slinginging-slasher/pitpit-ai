#!/usr/bin/env node
// Global launcher: run `codigo` inside any project directory. The agent operates on
// that directory (process.cwd()); the model + API key come from the app's shared
// config. Installed via `npm link` in the app directory. (`coder` is a legacy alias.)
//
//   codigo            -> desktop app (Electron window)
//   codigo cli|tui    -> interactive terminal REPL
//   codigo ui         -> chat web app in the browser (no Electron)
//
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import net from 'net';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
// Run tsx's JS entry directly with node instead of the .bin/tsx.cmd shim, so args
// pass as a safe argv array (no shell escaping/injection).
const tsx = resolve(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const mode = (process.argv[2] || '').toLowerCase();
const REPL = ['cli', 'tui', 'repl'];
const BROWSER = ['ui', 'gui', 'web', 'browser'];

/** Open a URL in the default browser, cross-platform, detached. */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* non-fatal */
  }
}

function portInUse(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
}

/** Ask the OS for a free ephemeral port. */
function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

if (REPL.includes(mode)) {
  // Interactive terminal REPL. Pass through any args after the subcommand.
  const cli = resolve(appDir, 'src', 'cli.ts');
  const child = spawn(process.execPath, [tsx, cli, ...process.argv.slice(3)], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (BROWSER.includes(mode)) {
  // Chat web app in the browser.
  const PORT = process.env.PORT || '7000';
  const url = `http://localhost:${PORT}/chat`;
  if (await portInUse(Number(PORT))) {
    console.log(`Server already running on :${PORT} — opening ${url}`);
    console.log(`(note: it operates on the directory that server was started in.)`);
    openBrowser(url);
    process.exit(0);
  }
  console.log(`Starting Codigo web app for ${process.cwd()}`);
  console.log(`Opening ${url}  (Ctrl+C to stop)`);
  const server = resolve(appDir, 'web', 'server.ts');
  const child = spawn(process.execPath, [tsx, server], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
  });
  setTimeout(() => openBrowser(url), 1500);
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  // Default: desktop app (Electron). Use a fresh free port so it never clashes with
  // the config UI (start.bat) on :7000, and always edits THIS directory.
  const electronPath = (await import('electron')).default;
  const port = await freePort();
  const main = resolve(appDir, 'electron', 'main.cjs');
  const child = spawn(electronPath, [main], {
    stdio: 'inherit',
    cwd: appDir,
    // CODER_NODE = this (system) node, so the server child — which loads node-pty for the
    // embedded terminal — runs under the ABI node-pty was built for, not Electron's.
    env: { ...process.env, CODER_CWD: process.cwd(), CODER_PORT: String(port), CODER_NODE: process.execPath },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
