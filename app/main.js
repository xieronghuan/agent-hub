'use strict';
/**
 * Agent Hub — Electron main process (config-driven, supports N agents).
 *
 * Several AI agents share one window. The architecture is peer-to-peer: every
 * agent keeps its own long-lived connection, none of them know the others exist,
 * and all routing lives in the relay.
 *
 * To add an agent, edit the `agents` array in ~/.agent-hub/config.json (or
 * app/agents.js) — this file does not need to change.
 *
 * Lifecycle:
 *   open the window → start each agent's own app-server (if it has one) →
 *   start the relay → show state. Closing the window kills every child process
 *   and sweeps the listening ports before quitting.
 *
 * Machine-specific values (paths, proxy) are never hardcoded. They all resolve
 * through app/config.js:
 *   env var → ~/.agent-hub/config.json → auto-detect → ask the user in Settings
 *
 * Every string a user can see lives in app/i18n.js.
 */

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const { Relay } = require('./relay-server');
const { discoverPorts } = require('./discover');
const cfg = require('./config');
const i18n = require('./i18n');
const t = i18n.t;

const HERE = __dirname;
// Once packaged, HERE sits inside the asar (read-only), so logs and config have
// to go to the user's home directory instead.
const RELAY_ROOT = app.isPackaged ? cfg.HOME_DIR : path.join(HERE, '..');
try { fs.mkdirSync(RELAY_ROOT, { recursive: true }); } catch (_) {}
const LOG_FILE = path.join(RELAY_ROOT, 'relay.log');
const ARCHIVE_FILE = path.join(RELAY_ROOT, 'relay.jsonl');
const WS_FILE = path.join(RELAY_ROOT, '.workspace');
const WB_SESSIONS = path.join(os.homedir(), '.workbuddy', 'sessions');

/* ---------- Locating things: env var → config → auto-detect → ask the user ---------- */

/** node.exe: prefer the copy bundled with WorkBuddy, then whatever is on PATH */
function autoNode() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^2[0-9]\./.test(d)).sort();
    if (dirs.length) {
      const p = path.join(base, dirs[dirs.length - 1], 'node.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  try {
    const first = String(execSync('where node', { encoding: 'utf8' }) || '').split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return '';
}

function findNode() {
  if (process.env.WB_NODE) return process.env.WB_NODE;
  const c = cfg.get('nodePath');
  if (c && fs.existsSync(c)) return c;
  return autoNode();
}

/** codex.exe lives under a hashed directory, so it can never be hardcoded */
function autoCodexCli() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  try {
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, 'codex.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return '';
}

function findCodexCli() {
  if (process.env.CODEX_CLI) return process.env.CODEX_CLI;
  const c = cfg.get('codexCliPath');
  if (c && fs.existsSync(c)) return c;
  return autoCodexCli();
}

/* Proxy: env var → config → probe common local ports → no proxy.
   Reaching Codex from mainland China usually needs one, but the port differs on
   every machine — the old code hardcoded 127.0.0.1:7897, which is one specific
   machine's Clash port and breaks everywhere else. */
const PROXY_PORTS = [7897, 7890, 10809, 10808, 1080, 8889, 2080];

function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(250);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(port, '127.0.0.1'); } catch (_) { fin(false); }
  });
}

async function resolveProxy() {
  if (process.env.RELAY_PROXY) return { proxy: process.env.RELAY_PROXY, src: t('proxy.srcEnv') };
  const c = String(cfg.get('proxy') || '').trim();
  if (c) return { proxy: c, src: t('proxy.srcConfig') };
  for (const p of PROXY_PORTS) {
    if (await isPortOpen(p)) return { proxy: 'http://127.0.0.1:' + p, src: t('proxy.srcAuto') };
  }
  return { proxy: '', src: t('proxy.srcNone') };
}

/** env var → config → follow the OS locale */
function pickLang() {
  const env = String(process.env.RELAY_LANG || '').toLowerCase();
  if (env === 'zh' || env === 'en') return env;
  const pref = String(cfg.get('uiLang') || 'auto').toLowerCase();
  if (pref === 'zh' || pref === 'en') return pref;
  try {
    return String(app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch (_) {
    return 'zh';
  }
}

/** Temp directories are never workspaces. Note `\Temp` without a trailing slash counts too. */
function isTempPath(p) {
  return /[\\/](Temp|tmp|__workbuddy_cli_host__)([\\/]|$)/i.test(String(p || ''));
}

let AGENTS = [];
function loadAgents() {
  AGENTS = (cfg.get('agents') || []).filter((a) => a && a.id).map((a) => Object.assign({}, a));
  return AGENTS;
}
loadAgents();

/** The bottom bar's "Everyone" entry: one message goes to every agent */
const ALL = '__all__';
/** Every agent that is actually enabled */
function liveAgents() { return AGENTS.filter((a) => a.enabled !== false); }

// Running from source: default workspace is the repo root (one level above app/).
// Packaged there is no repo, so fall back to the home directory.
const PROJECT_ROOT = app.isPackaged ? os.homedir() : path.resolve(HERE, '..');
const NODE = findNode();
const CODEX_CLI = findCodexCli();
const CWD = process.env.WB_CWD || PROJECT_ROOT;

/* ---------- Workspaces ---------- */

function listWorkspaces() {
  const map = new Map();
  try {
    for (const f of fs.readdirSync(WB_SESSIONS)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(WB_SESSIONS, f), 'utf8'));
        const cwd = j.cwd;
        if (!cwd || isTempPath(cwd)) continue;
        const k = cwd.toLowerCase();
        const p = map.get(k);
        if (!p || (j.lastHeartbeat || 0) > p.t) map.set(k, { cwd, t: j.lastHeartbeat || 0 });
      } catch (_) {}
    }
  } catch (_) {}
  const all = Array.from(map.values()).sort((a, b) => b.t - a.t).map((x) => x.cwd);
  if (PROJECT_ROOT && fs.existsSync(PROJECT_ROOT) && !isTempPath(PROJECT_ROOT)
      && !all.some((c) => c.toLowerCase() === PROJECT_ROOT.toLowerCase())) {
    all.unshift(PROJECT_ROOT);
  }
  return all;
}

let workspaces = [];
function loadSavedWs() {
  try {
    const s = fs.readFileSync(WS_FILE, 'utf8').trim();
    if (s && fs.existsSync(s) && !isTempPath(s)) return s;
  } catch (_) {}
  if (!app.isPackaged && fs.existsSync(PROJECT_ROOT) && !isTempPath(PROJECT_ROOT)) return PROJECT_ROOT;
  const home = os.homedir().toLowerCase();
  const real = (workspaces || []).find((w) => !isTempPath(w) && String(w).toLowerCase() !== home);
  return real || os.homedir();
}

/* ---------- State ---------- */

let win = null;
let settingsWin = null;
const kids = [];
const wsOf = {};                 // agentId → that agent's workspace (they can differ)
let quitting = false;
let relay = null;
let acpPorts = [];
let proxyInfo = { proxy: '', src: '' };
let autoHintShown = false;        // 自动接力的提示每次运行只说一次，别每发一条都刷

/* ---------- Pushing to the UI ---------- */

function push(e) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('term-line', e); } catch (_) {}
  }
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${e.who || 'sys'} ${e.text}\n`, 'utf8'); } catch (_) {}
}

function setStatus(text, statuses) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('term-status', { text, statuses }); } catch (_) {}
  }
}

function log(msg) { push({ who: 'sys', text: msg }); }

/** Display name for an agent id */
function nameOf(id) {
  const a = AGENTS.find((x) => x.id === id);
  return a ? (a.name || a.id) : id;
}

/** Push the agent list, the workspace list and each agent's status to the UI */
function pushWsList() {
  if (!win || win.isDestroyed()) return;
  const agents = AGENTS.filter((a) => a.enabled !== false).map((a) => ({
    id: a.id, name: a.name || a.id, color: a.color || '', cwd: wsOf[a.id] || '',
  }));
  const statuses = relay ? relay.status() : {};
  // ACP 腿把当前模型和可选项一起带给界面（Codex 腿没有这个信息，界面上就不显示下拉）
  const models = relay && relay.modelInfo ? relay.modelInfo() : {};
  try { win.webContents.send('term-wslist', { agents, list: workspaces, statuses, models }); } catch (_) {}
}

/** The status bar only reports how many are connected; details are the lights */
function refreshStatus(list) {
  const st = list || (relay ? relay.status() : {});
  const ids = Object.keys(st);
  const ready = ids.filter((k) => st[k] === 'ready').length;
  setStatus(ids.length ? t('status.connected', { ready, total: ids.length }) : t('status.starting'), st);
}

/* ---------- Process management ---------- */

function spawnRaw(cmdline, tag) {
  const child = spawn(cmdline, [], { cwd: CWD, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(child);
  if (child.stdout) child.stdout.on('data', (d) => log(`[${tag}] ` + String(d).trimEnd()));
  if (child.stderr) child.stderr.on('data', (d) => log(`[${tag}!] ` + String(d).trimEnd()));
  child.on('exit', (c) => log(t('proc.exited', { tag, code: c })));
  return child;
}

/** Kill whatever is listening on a port — a service may have daemonised and left the spawn tree */
function killByPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      if (line.indexOf('127.0.0.1:' + port) < 0 || line.indexOf('LISTENING') < 0) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) {
        push({ who: 'sys', text: t('proc.cleanup', { pid }) });
        spawn('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
      }
    }
  } catch (_) {}
}

function killKids() {
  for (const k of kids) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(k.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-k.pid, 'SIGTERM');
    } catch (_) {}
  }
  kids.length = 0;
  // Take down the listening ports the agents opened as well
  for (const a of AGENTS) if (a.port) killByPort(a.port);
  killByPort(Number(process.env.WB_PORT || 8788));
}

async function waitPort(port, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const out = execSync('netstat -ano', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (out.split('\n').some((l) => l.indexOf('127.0.0.1:' + port) >= 0 && l.indexOf('LISTENING') >= 0)) return true;
    } catch (_) {}
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Is anything listening on this port right now? */
function portBusy(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return out.split('\n').some((l) => l.indexOf('127.0.0.1:' + port) >= 0 && l.indexOf('LISTENING') >= 0);
  } catch (_) { return false; }
}

/* ---------- Input handling ---------- */

function helpText() {
  return [
    t('help.intro'),
    t('help.ws'),
    t('help.wsSwitch'),
    t('help.target'),
    t('help.everyone'),
    t('help.auto'),
    t('help.stop'),
    t('help.status'),
    t('help.clear'),
    t('help.help'),
    t('help.buttons', { settings: t('ui.settings'), clear: t('ui.clearHistory') }),
  ].join('\n');
}

function targetOf() { return _target; }
function setTarget(id) { _target = id; }
let _target = null;

async function handleInput(text, to) {
  if (text === '/help') { log(helpText()); return; }
  if (text === '/clear') { push({ who: 'clear' }); return; }
  if (text === '/stop') {
    if (relay && relay.disarm) relay.disarm();
    log(t('relay.autoOff'));
    return;
  }
  if (text === '/status') {
    log(t('boot.status', { json: JSON.stringify(relay ? relay.status() : {}) }));
    log(t('cmd.workspaces', { json: JSON.stringify(wsOf) }));
    return;
  }
  if (text === '/ws' || text.startsWith('/ws ')) {
    const a = text.slice(3).trim();
    if (!a) { log(t('cmd.workspaceList')); workspaces.forEach((w, i) => log(`  ${i + 1}. ${w}`)); return; }
    const n = Number(a);
    const pick = (Number.isInteger(n) && n >= 1 && n <= workspaces.length) ? workspaces[n - 1] : a;
    if (!fs.existsSync(pick)) { log(t('cmd.pathMissing', { path: pick })); return; }
    // Follow whatever the bottom bar is on; "Everyone" switches all of them
    const cur = to || targetOf() || (AGENTS[0] && AGENTS[0].id);
    const targets = cur === ALL ? liveAgents().map((x) => x.id) : [cur];
    for (const id of targets) await applyWs(id, pick);
    return;
  }
  if (text === '/t' || text.startsWith('/t ')) {
    const a = text.slice(2).trim();
    if (AGENTS.some((x) => x.id === a)) { setTarget(a); log(t('cmd.targetSet', { id: a })); pushWsList(); }
    else log(t('cmd.targetOptions', { list: AGENTS.map((x) => x.id).join(' / ') }));
    return;
  }

  const tgt = to || targetOf() || (AGENTS[0] && AGENTS[0].id);
  if (!relay || !relay.started) { log(t('cmd.relayNotReady')); return; }

  // "Everyone" fans one message out to every enabled agent
  const targets = tgt === ALL
    ? liveAgents()
    : [AGENTS.find((a) => a.id === tgt)].filter(Boolean);
  if (!targets.length) {
    log(t('cmd.targetOptions', { list: AGENTS.map((x) => x.id).join(' / ') }));
    return;
  }

  push({ who: 'sys', text: t('cmd.sentTo', { names: targets.map((a) => a.name || a.id).join(', ') }) });

  // Auto-relay is on for every message: whichever agent answers, its reply gets
  // passed to the other one. Sending again just restarts the round counter;
  // /stop ends the current round. autoRelay:false in config turns it all off.
  if (relay.arm && relay.autoRelay) {
    relay.arm();
    if (!autoHintShown) {
      autoHintShown = true;
      log(relay.maxHops > 0
        ? t('relay.autoArmed', { n: relay.maxHops })
        : t('relay.autoArmedNoLimit'));
    }
  }

  for (const a of targets) {
    const r = await relay.send(a.id, text);
    if (!r.ok) log(t('cmd.sendFailedTo', { name: a.name || a.id, msg: r.error }));
  }
}

/** Point one agent at a different workspace */
async function applyWs(agentId, p) {
  wsOf[agentId] = p;
  try { fs.writeFileSync(WS_FILE, p, 'utf8'); } catch (_) {}
  log(t('ws.switched', { id: agentId, path: p }));
  if (relay && relay.started) {
    try { await relay.switchWs(agentId, p); } catch (e) { log(t('cmd.switchFailed', { msg: e.message })); }
  }
  pushWsList();
}

/* ---------- Boot ---------- */

async function boot() {
  log(t('boot.title'));
  log(t('boot.configFile', {
    file: cfg.FILE,
    suffix: fs.existsSync(cfg.FILE) ? '' : t('boot.configMissing'),
  }));
  log(t('boot.node', { path: NODE || t('boot.nodeMissing') }));

  proxyInfo = await resolveProxy();
  log(proxyInfo.proxy
    ? t('boot.proxySet', { proxy: proxyInfo.proxy, src: proxyInfo.src })
    : t('boot.proxyNone'));
  for (const a of AGENTS) {
    if (a.kind === 'codex-app-server') a.proxy = a.proxy || proxyInfo.proxy;
  }

  workspaces = listWorkspaces();
  const def = loadSavedWs();
  for (const a of AGENTS) wsOf[a.id] = def;
  log(t('boot.wsFound', { n: workspaces.length, path: def }));
  pushWsList();

  // Missing a key path? Put Settings in front of the user instead of a doc link
  const needCodex = AGENTS.some((a) => a.enabled !== false && a.kind === 'codex-app-server');
  if (needCodex && !CODEX_CLI) {
    log(t('boot.noCodexCli'));
    setTimeout(() => openSettings(), 700);
  }

  // 1) Start each agent's own app-server (the ones that declare a port)
  for (const a of AGENTS) {
    if (a.enabled === false) continue;
    if (a.kind !== 'codex-app-server' || !a.port) continue;
    if (!CODEX_CLI) { log(t('boot.legSkipped', { name: a.name })); continue; }
    const lf = path.join(RELAY_ROOT, a.id + '-app.log');
    const px = a.proxy || '';
    // A previous run that was force-killed (Task Manager / `taskkill /F`) leaves the
    // app-server alive, holding the port. It also still holds the conversation's
    // write lock, which makes the Codex client complain "already open in another
    // app". So clear any leftover before starting a fresh one.
    if (portBusy(a.port)) {
      log(t('boot.portBusy', { name: a.name, port: a.port }));
      killByPort(a.port);
      await new Promise((r) => setTimeout(r, 1000));
      if (quitting) return;
    }
    // Codex needs the proxy, otherwise turns hang forever in inProgress
    const env = px
      ? `set "HTTPS_PROXY=${px}" && set "HTTP_PROXY=${px}" && set "ALL_PROXY=${px}" && `
      : '';
    log(t('boot.startingServer', { name: a.name }));
    spawnRaw(`${env}"${CODEX_CLI}" app-server --listen ws://127.0.0.1:${a.port} > "${lf}" 2>&1`, a.id);
    const up = await waitPort(a.port, 30000);
    if (quitting) return;
    log(up
      ? t('boot.serverReady', { name: a.name, port: a.port })
      : t('boot.serverTimeout', { name: a.name, port: a.port }));
  }

  // 2) Discover ACP ports (WorkBuddy and friends change port on every start)
  log(t('boot.discoverAcp'));
  acpPorts = await discoverPorts();
  log(acpPorts.length ? t('boot.portsFound', { list: acpPorts.join(', ') }) : t('boot.noAcpPort'));

  // 3) Start the peer relay: every agent connects at once, routing stays in here
  log(t('boot.startingRelay'));
  relay = new Relay({
    agents: AGENTS,
    cwd: def,
    cwds: wsOf,
    // The archive has to live in the user directory too: __dirname is inside the
    // read-only asar once packaged.
    logFile: ARCHIVE_FILE,
    autoRelay: cfg.get('autoRelay') !== false,
    maxHops: Number(cfg.get('autoRelayMaxHops') || 0),   // 0 = 不限轮数
    borrowClientSession: cfg.get('borrowClientSession') !== false,
  });
  relay.on('info', (m) => log(m));
  relay.on('delta', ({ from, text }) => push({ who: from, text }));
  relay.on('reasoning', ({ text }) => push({ who: 'sys', text: '· ' + text }));
  relay.on('turnDone', ({ from }) => log(t('turn.done', { name: nameOf(from) })));
  relay.on('status', (s) => refreshStatus(s));

  try {
    const st = await relay.start();
    refreshStatus(st);
    log(t('boot.status', { json: JSON.stringify(st) }));
    log(t('boot.ready'));
    setTarget((AGENTS.find((a) => st[a.id] === 'ready') || AGENTS[0] || {}).id);
    pushWsList();
  } catch (e) {
    log(t('boot.relayFailed', { msg: e.message }));
    setStatus(t('status.relayFailed'));
  }

  if (process.env.RELAY_SHOT === '1') {
    // Verification only: run, screenshot, quit by itself
    setTimeout(async () => {
      if (process.env.RELAY_SHOT_SETTINGS === '1') {
        openSettings();
        await new Promise((r) => setTimeout(r, 2500));
      }
      const shots = [['main', win, 'shot.png'], ['settings', settingsWin, 'shot-settings.png']];
      for (const [label, w, f] of shots) {
        if (!w || w.isDestroyed()) { log(`shot skipped (${label}): no window`); continue; }
        try { w.show(); w.focus(); } catch (_) {}
        const r = await shoot(w.webContents, path.join(RELAY_ROOT, f));
        log(r === true ? `shot ok → ${f}` : (r ? `capturePage failed, fell back to printToPDF → ${String(f).replace(/\.png$/, '.pdf')}` : `shot failed (${label}): no frames available`));
      }
      setTimeout(() => { quitting = true; killKids(); setTimeout(() => app.quit(), 800); }, 500);
    }, Number(process.env.RELAY_SHOT_DELAY) || 4000);
  }
}

/**
 * Screenshot helper: try capturePage (3 attempts), then fall back to printToPDF.
 *
 * A locked desktop / invisible session makes Chromium's compositor report
 * UnknownVizError — that has nothing to do with packaging. The PDF at least
 * leaves a readable record of the layout.
 */
async function shoot(wc, file) {
  for (let i = 0; i < 3; i++) {
    try {
      const png = (await wc.capturePage()).toPNG();
      if (png && png.length > 1000) { fs.writeFileSync(file, png); return true; }
    } catch (_) {}
    try { wc.invalidate(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
  }
  try {
    fs.writeFileSync(file.replace(/\.png$/, '.pdf'), await wc.printToPDF({ printBackground: true }));
    return 'pdf';
  } catch (_) { return false; }
}

/* ---------- Windows ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 760,
    minHeight: 460,
    title: 'Agent Hub',
    autoHideMenuBar: true,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(HERE, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(HERE, 'ui', 'term.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

/** The settings window does one job: let people fill in paths/proxy without reading docs */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return settingsWin; }
  settingsWin = new BrowserWindow({
    width: 660,
    height: 700,
    title: t('win.settingsTitle'),
    parent: win || undefined,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(HERE, 'preload.js'),
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(HERE, 'ui', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

/* ---------- IPC ---------- */

/** The renderer asks for its dictionary synchronously while preload runs */
ipcMain.on('i18n-sync', (e) => {
  const lang = i18n.getLang();
  e.returnValue = { lang, dict: i18n.DICT[lang] || i18n.DICT.zh };
});

ipcMain.on('term-send', (_e, payload) => {
  const text = typeof payload === 'string' ? payload : String((payload && payload.text) || '');
  const to = typeof payload === 'object' && payload ? payload.to : undefined;
  handleInput(text, to);
});

ipcMain.on('term-selectws', async (_e, d) => {
  if (!d || d.side === undefined || d.side === null || !d.path) return;
  await applyWs(d.side, d.path);
});

/** 换某个 agent 的模型（ACP 腿）；成功后模型信息会随下一次 pushWsList 刷新 */
ipcMain.on('term-setmodel', async (_e, d) => {
  if (!d || !d.side || !d.value) return;
  try {
    await relay.setConfig(d.side, 'model', d.value);
  } catch (e) {
    log(t('relay.modelFailed', { msg: e.message }));
  }
  pushWsList();
});

/** Clear the archive (relay.jsonl) — asks first, cannot be undone */
ipcMain.handle('log-clear', async () => {
  let lines = 0;
  try {
    if (fs.existsSync(ARCHIVE_FILE)) lines = fs.readFileSync(ARCHIVE_FILE, 'utf8').split('\n').filter(Boolean).length;
  } catch (_) {}
  const r = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    buttons: [t('log.clearCancel'), t('log.clearOk')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: t('log.clearTitle'),
    detail: t('log.clearDetail', { file: ARCHIVE_FILE, n: lines }),
  });
  if (r.response !== 1) return { ok: false, cancelled: true };
  try {
    fs.writeFileSync(ARCHIVE_FILE, '', 'utf8');
  } catch (e) {
    log(t('log.clearFailed', { msg: e.message }));
    return { ok: false, error: e.message };
  }
  log(t('log.cleared', { n: lines, file: ARCHIVE_FILE }));
  return { ok: true, cleared: lines, file: ARCHIVE_FILE };
});

ipcMain.handle('cfg-open', () => { openSettings(); return true; });

ipcMain.handle('cfg-get', () => {
  const c = cfg.get();
  const codexLeg = (c.agents || []).find((a) => a.kind === 'codex-app-server') || {};
  return {
    file: cfg.FILE,
    hasFile: fs.existsSync(cfg.FILE),
    nodePath: c.nodePath || '',
    codexCliPath: c.codexCliPath || '',
    proxy: c.proxy || '',
    codexPort: codexLeg.port || '',
    uiLang: c.uiLang || 'auto',
    lang: i18n.getLang(),
    resolved: {
      node: NODE,
      codexCli: CODEX_CLI,
      nodeAuto: autoNode(),
      codexCliAuto: autoCodexCli(),
      proxyEnv: process.env.RELAY_PROXY || '',
      proxyNow: proxyInfo.proxy || '',
      proxySrc: proxyInfo.src || '',
    },
  };
});

ipcMain.handle('cfg-save', (_e, patch) => {
  const p = Object.assign({}, patch || {});
  if (p.codexPort !== undefined) {
    const port = Number(p.codexPort) || 8899;
    p.agents = (cfg.get('agents') || []).map((a) =>
      (a.kind === 'codex-app-server' ? Object.assign({}, a, { port }) : a));
    delete p.codexPort;
  }
  const r = cfg.save(p);
  if (r.ok) log(t('set.savedLog', { file: r.file }));
  else log(t('set.saveFailedLog', { msg: r.error }));
  return r;
});

ipcMain.handle('cfg-pick', async (_e, kind) => {
  const isNode = kind === 'node';
  const parent = (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : (win || undefined);
  const r = await dialog.showOpenDialog(parent, {
    title: isNode ? t('set.pickNode') : t('set.pickCodex'),
    properties: ['openFile'],
    filters: [{ name: isNode ? 'node' : 'codex', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('cfg-detect', () => ({ ok: true, node: autoNode(), codexCli: autoCodexCli() }));

ipcMain.handle('cfg-restart', () => {
  log(t('set.restarting'));
  quitting = true;
  killKids();
  setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
  return true;
});

ipcMain.on('cfg-close', () => { try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); } catch (_) {} });

/* ---------- Lifecycle ---------- */

app.whenReady().then(() => {
  i18n.setLang(pickLang());
  createWindow();
  boot();
});

app.on('window-all-closed', () => { quitting = true; killKids(); app.quit(); });
app.on('before-quit', () => { quitting = true; killKids(); });
process.on('exit', killKids);
