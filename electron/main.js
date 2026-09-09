const http = require('http');
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const CONFIG_DIR = path.join(require('os').homedir(), '.config', 'wallpaper-switcher');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const METADATA_FILE = path.join(CONFIG_DIR, 'metadata.json');
const STORAGE_DIR = path.join(CONFIG_DIR, 'storage');
const PHOTOS_DIR = path.join(STORAGE_DIR, 'photos');
const THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');
const WALLPAPERS_DIR = path.join(CONFIG_DIR, 'wallpapers');
const SERVER_PORT = 18234;

const PACKAGED_SCRIPT = path.join(process.resourcesPath, 'wallpaper-switcher.py');
const DEV_SCRIPT = path.join(__dirname, '..', 'wallpaper-switcher.py');
const SCRIPT_PATH = fs.existsSync(PACKAGED_SCRIPT) ? PACKAGED_SCRIPT : DEV_SCRIPT;

let server;
let tzOffsetSeconds = -new Date().getTimezoneOffset() * 60;
let tzName = null;
try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch (e) { tzName = 'local'; }

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url);

      // Serve fotos do storage
      if (url.startsWith('/photos/')) {
        const filename = url.replace('/photos/', '');
        const filePath = path.join(PHOTOS_DIR, filename);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(content);
          return;
        }
        res.writeHead(404); res.end('Not found');
        return;
      }

      // Serve thumbnails de videos
      if (url.startsWith('/thumbnails/')) {
        const filename = url.replace('/thumbnails/', '');
        const filePath = path.join(THUMBNAILS_DIR, filename);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(content);
          return;
        }
        res.writeHead(404); res.end('Not found');
        return;
      }

      // Serve arquivos do build Next.js
      let filePath = path.join(__dirname, '..', 'out', url === '/' ? 'index.html' : url);
      if (!fs.existsSync(filePath)) filePath = path.join(__dirname, '..', 'out', 'index.html');
      const ext = path.extname(filePath);
      try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
      } catch (e) { res.writeHead(404); res.end('Not found'); }
    });
    server.listen(SERVER_PORT, '127.0.0.1', () => resolve());
  });
}

function getMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
      if (!data.images) data.images = [];
      return data;
    }
  } catch (e) {}
  return { images: [], current_id: null };
}

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (!cfg.timer_mode) cfg.timer_mode = 'interval';
      return cfg;
    }
  } catch (e) {}
  return { timer_hours: 2, timer_minutes: 0, timer_mode: 'interval', jpeg_quality: 80, max_width: 3840 };
}

function saveConfig(config) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (e) { return false; }
}

function runScript(args) {
  try {
    const result = execSync(`python3 "${SCRIPT_PATH}" ${args}`, { encoding: 'utf-8', timeout: 120000 });
    return { success: true, output: result };
  } catch (e) {
    return { success: false, output: e.stderr || e.message };
  }
}

// ──────────────────────────────────────────────
// Timer: toda a logica em UTC (naive). O fuso local
// e aplicado apenas na mascara de exibicao (frontend).
// ──────────────────────────────────────────────

function utcParts(ms) {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

// A logica de agendamento (proximo disparo) vive 100% no backend python,
// em UTC naive. Aqui so se invoca o python e se repassa o JSON.
function scheduleFromConfig(baseMs, hours, minutes, mode) {
  const b = typeof baseMs === 'number' && !isNaN(baseMs) ? Math.round(baseMs) : Date.now();
  const cmd = `schedule --base ${b} --hours ${hours || 0} --minutes ${minutes || 0} --mode ${mode || 'interval'}`;
  return parseScheduleOutput(runScript(cmd));
}

// Versao somente-leitura: calcula o proximo no backend SEM tocar no systemd.
// Usado em leituras de status para que a poll de 15s NUNCA rearme o alarme.
function scheduleQueryFromConfig(hours, minutes, mode) {
  const cmd = `schedule --query --hours ${hours || 0} --minutes ${minutes || 0} --mode ${mode || 'interval'}`;
  return parseScheduleOutput(runScript(cmd));
}

function parseScheduleOutput(res) {
  if (!res || !res.success) return null;
  try {
    const j = JSON.parse(res.output.trim());
    return (j && j.ok) ? j : null;
  } catch (e) { return null; }
}

function isTimerActive() {
  try {
    const out = execSync('systemctl --user is-active wallpaper-switcher.timer', { encoding: 'utf-8', timeout: 5000 }).trim();
    return out === 'active';
  } catch (e) { return false; }
}

function discoverTimezone() {
  const fallback = () => {
    tzOffsetSeconds = -new Date().getTimezoneOffset() * 60;
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
    catch (e) { tzName = 'local'; }
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    fetch('http://ip-api.com/json', { signal: controller.signal })
      .then(r => r.json())
      .then(j => {
        clearTimeout(timer);
        if (j && typeof j.offset === 'number') {
          tzOffsetSeconds = j.offset;
          tzName = j.timezone || null;
        } else {
          fallback();
        }
      })
      .catch(() => { clearTimeout(timer); fallback(); });
  } catch (e) {
    fallback();
  }
}

function getTimerStatus() {
  const cfg = getConfig();
  const mode = cfg.timer_mode || 'interval';
  let active = false;
  let nextMs = null;
  try {
    const out = execSync('systemctl --user show wallpaper-switcher.timer -p ActiveState -p NextElapseUSecRealtime', { encoding: 'utf-8', timeout: 5000 });
    const am = out.match(/ActiveState=(\S+)/);
    if (am) active = am[1] === 'active';
    const nm = out.match(/NextElapseUSecRealtime=(\d+)/);
    if (nm && Number(nm[1]) > 0) nextMs = Math.round(Number(nm[1]) / 1000);
  } catch (e) {}

  let parts = null;
  if (nextMs) {
    // Verdade armada: o instante absoluto que o systemd vai disparar.
    // Ja segue o rearmer do python, entao nunca "anda" sozinho.
    parts = utcParts(nextMs);
  } else {
    // Sem NextElapse (timer nunca armado / off): calcula agora+X no backend,
    // SEM rearmar (--query) - ler status nunca muda o alarme.
    const q = scheduleQueryFromConfig(cfg.timer_hours, cfg.timer_minutes, mode);
    if (q && q.next) {
      const n = q.next;
      parts = { year: n.year, month: n.month, day: n.day, hour: n.hour, minute: n.minute };
      nextMs = q.next_epoch_ms;
    }
  }
  if (!parts) parts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0 };

  return { ok: true, active, mode, hours: cfg.timer_hours, minutes: cfg.timer_minutes, next: parts, nextMs, tzOffsetSeconds, tzName };
}

function ensureBackend() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
  fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ timer_hours: 2, timer_minutes: 0, timer_mode: 'interval', jpeg_quality: 80, max_width: 3840 }, null, 2));
  }
  if (!fs.existsSync(METADATA_FILE)) {
    fs.writeFileSync(METADATA_FILE, JSON.stringify({ images: [], current_id: null }, null, 2));
  }

  // Bootstrap: o python (unico que escreve units) arma a partir da config.
  const cfg = getConfig();
  scheduleFromConfig(null, cfg.timer_hours, cfg.timer_minutes, cfg.timer_mode || 'interval');
}

function toggleTimer(enable) {
  try {
    const cfg = getConfig();
    // Python arma o unit (restart so se estiver ativo -> nunca liga sozinho).
    scheduleFromConfig(null, cfg.timer_hours, cfg.timer_minutes, cfg.timer_mode || 'interval');
    if (enable) {
      execSync('systemctl --user enable --now wallpaper-switcher.timer', { timeout: 5000 });
    } else {
      execSync('systemctl --user disable --now wallpaper-switcher.timer', { timeout: 5000 });
    }
    return { ok: true, ...getTimerStatus() };
  } catch (e) {
    return { ok: false, active: false, next: null };
  }
}

app.name = 'Wallpaper Switcher';
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1000, height: 700, resizable: true,
    frame: false,
    transparent: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    title: 'Wallpaper Switcher',
    icon: path.join(require('os').homedir(), 'Pictures', 'Icons', 'omnitrix.png'),
  });
  win.loadURL(`http://127.0.0.1:${SERVER_PORT}/`);
  return win;
}

app.whenReady().then(async () => {
  await startServer();
  ensureBackend();
  discoverTimezone();

  ipcMain.handle('get-metadata', () => getMetadata());
  ipcMain.handle('get-config', () => getConfig());
  ipcMain.handle('save-config', (_, config) => saveConfig(config));

  ipcMain.handle('add-image', async (_, filePath) => runScript(`add "${filePath}"`));
  ipcMain.handle('remove-media', (_, id) => runScript(`remove "${id}"`));
  ipcMain.handle('set-wallpaper', (_, id) => runScript(id ? `set --id "${id}"` : 'set'));

  ipcMain.handle('get-mode', () => {
    const cfg = getConfig();
    return cfg.current_mode || 'photo';
  });

  ipcMain.handle('set-mode', (_, mode) => {
    const cfg = getConfig();
    cfg.current_mode = mode;
    saveConfig(cfg);
    return { ok: true, mode };
  });

  ipcMain.handle('list-videos', () => {
    const result = runScript('list-videos');
    if (!result.success) return [];
    try {
      const vids = JSON.parse(result.output.trim());
      return vids.map(v => ({
        ...v,
        thumbnailUrl: v.thumbnail ? `http://127.0.0.1:${SERVER_PORT}/thumbnails/${path.basename(v.thumbnail)}` : null,
      }));
    } catch (e) { return []; }
  });

  ipcMain.handle('set-video', (_, name) => runScript(name ? `set-video "${name}"` : 'set-video'));

  ipcMain.handle('quit-hidamari', () => runScript('quit-hidamari'));

  ipcMain.handle('remove-video', (_, name) => runScript(`remove-video "${name}"`));

  ipcMain.handle('add-video', async (_, filePath) => runScript(`add-video "${filePath}"`));

  ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'mp4', 'mkv', 'webm'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] },
        { name: 'Videos', extensions: ['mp4', 'mkv', 'webm'] },
      ],
    });
    return result.filePaths;
  });

  ipcMain.handle('get-images', () => {
    const meta = getMetadata();
    return meta.images.map(img => ({
      ...img,
      thumbnail: `http://127.0.0.1:${SERVER_PORT}/photos/${img.filename}`,
    }));
  });

  ipcMain.handle('get-timer-status', () => getTimerStatus());
  ipcMain.handle('toggle-timer', (_, enable) => toggleTimer(enable));
  ipcMain.handle('update-timer', (_, hours, minutes, mode, baseMs) => {
    const cfg = getConfig();
    cfg.timer_hours = hours;
    cfg.timer_minutes = minutes;
    cfg.timer_mode = mode || 'interval';
    saveConfig(cfg);

    // Backend python calcula o proximo a partir da base enviada pelo
    // frontend (UTC naive) - reiniciado se ativo -> conte a partir do clique.
    const payload = scheduleFromConfig(baseMs, hours, minutes, mode || 'interval');
    if (!payload) return { ok: false, active: isTimerActive(), next: null };
    return {
      ok: true,
      active: payload.active,
      mode: payload.mode,
      hours: payload.hours,
      minutes: payload.minutes,
      next: payload.next,
      nextMs: payload.next_epoch_ms,
      tzOffsetSeconds,
      tzName,
    };
  });

  // Controles de janela (frame: false)
  ipcMain.on('win-close', () => win && win.close());
  ipcMain.on('win-minimize', () => win && win.minimize());
  ipcMain.on('win-maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  let win = createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { win = createWindow(); } });
});

app.on('window-all-closed', () => { if (server) server.close(); if (process.platform !== 'darwin') app.quit(); });