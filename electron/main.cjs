// Electron main process for the Coder desktop app.
// Launched by `coder` (see bin/coder.mjs), which passes CODER_CWD (the folder the
// agent should edit) and CODER_PORT (a free port) via the environment. This process
// starts the existing web server as a child, then opens a window at /chat.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

/** Locate a real system node.exe on PATH — needed so node-pty (native, built for the
 * system node ABI) loads. Returns null if none found (then we fall back to Electron-as-node). */
function findSystemNode() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

const appDir = path.dirname(__dirname); // electron/ -> project root
// 0 = pick a free port at startup (used when launched directly, e.g. from the Start-menu
// shortcut). bin/coder.mjs passes a specific CODER_PORT in dev.
let PORT = Number(process.env.CODER_PORT) || 0;
const AGENT_CWD = process.env.CODER_CWD || process.cwd(); // the project the agent edits

let serverProc = null;

/** Ask the OS for a free ephemeral port. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** Resolve once the port accepts connections, or reject after a timeout. */
function waitForPort(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server did not start in time'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

/** Start the web server (tsx) as a plain-Node child, editing AGENT_CWD. */
async function startServer() {
  if (!PORT) PORT = await freePort(); // resolve a free port when none was provided
  const tsx = path.join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const server = path.join(appDir, 'web', 'server.ts');
  // Run the server under SYSTEM node so node-pty (native, built for the system node ABI)
  // loads. Prefer CODER_NODE (dev), else find node on PATH; only as a last resort run the
  // Electron binary as node (terminals may not work then, but chat still will).
  const sysNode = process.env.CODER_NODE || findSystemNode();
  const nodeExe = sysNode || process.execPath;
  const env = { ...process.env, PORT: String(PORT) };
  if (!sysNode) env.ELECTRON_RUN_AS_NODE = '1';
  serverProc = spawn(nodeExe, [tsx, server], { cwd: AGENT_CWD, env, stdio: 'ignore' });
  serverProc.on('exit', () => { serverProc = null; });
  await waitForPort(PORT);
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1a1a1a',
    title: 'Codigo',
    icon: path.join(appDir, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Open external links (http/https not to our server) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await win.loadURL(`http://localhost:${PORT}/chat`);
}

// Single instance: if Codigo is already running, focus/flash that window instead of
// opening a second app. The second launch acquires no lock and quits immediately.
app.setName('Codigo');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === 'win32') win.flashFrame(true);
  }
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.pitpit.codigo');
  try {
    await startServer();
  } catch (e) {
    // Surface a minimal error page instead of a blank window.
    const win = new BrowserWindow({ width: 700, height: 300, backgroundColor: '#1a1a1a', title: 'Codigo' });
    win.loadURL('data:text/html,' + encodeURIComponent(`<body style="background:#1a1a1a;color:#e8e8e8;font-family:sans-serif;padding:30px"><h2>Could not start the Codigo server</h2><pre>${e.message}</pre></body>`));
    return;
  }
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProc) { try { serverProc.kill(); } catch { /* ignore */ } }
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProc) { try { serverProc.kill(); } catch { /* ignore */ } }
});
