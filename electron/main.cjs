// Electron main process for the Coder desktop app.
// Launched by `coder` (see bin/coder.mjs), which passes CODER_CWD (the folder the
// agent should edit) and CODER_PORT (a free port) via the environment. This process
// starts the existing web server as a child, then opens a window at /chat.
const { app, BrowserWindow, shell, ipcMain, Menu } = require('electron');
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

// --- Window size/position persistence (remember bounds across close/relaunch) ---
function winStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(winStateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds = the un-maximized bounds, so restoring a maximized window still knows
    // its "restore" size. Store the maximized flag separately.
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(winStateFile(), JSON.stringify({ ...b, isMaximized: win.isMaximized() }));
  } catch {
    /* best-effort */
  }
}
// True if the saved rectangle still overlaps a connected display (so we don't restore a window
// off-screen after a monitor is unplugged).
function boundsVisible(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') return false;
  try {
    const { screen } = require('electron');
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + (b.width || 0) > a.x && b.y < a.y + a.height && b.y + (b.height || 0) > a.y;
    });
  } catch {
    return false;
  }
}

async function createWindow() {
  const saved = loadWindowState();
  const useSaved = saved && boundsVisible(saved);
  const win = new BrowserWindow({
    width: useSaved && saved.width ? saved.width : 1200,
    height: useSaved && saved.height ? saved.height : 820,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1a1a1a',
    title: 'Codigo',
    icon: path.join(appDir, 'assets', 'icon.png'),
    autoHideMenuBar: false, // show the File/Edit/View menu (DevTools, Reload, copy/paste)
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Allow clipboard read/write so the terminal's Ctrl+V / right-click paste works.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write' || permission === 'clipboard-write');
  });

  // Open external links (http/https not to our server) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (saved && saved.isMaximized) win.maximize();

  // Persist size/position on change (debounced) and on close, so the next launch restores them.
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);
  win.on('close', () => saveWindowState(win));

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

// Relaunch the whole app (triggered by the Relaunch button via preload). Drop CODER_PORT
// so the fresh instance picks a new free port instead of racing the exiting server.
ipcMain.on('codigo:relaunch', () => {
  delete process.env.CODER_PORT;
  app.relaunch();
  app.exit(0);
});

/** App menu: File / Edit (cut-copy-paste) / View (Reload + DevTools + zoom) / Window. */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'File', submenu: [{ role: 'quit' }] },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' }, { role: 'togglefullscreen' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  );
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.pitpit.codigo');
  buildMenu();
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
