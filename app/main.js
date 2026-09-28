'use strict';
/**
 * Agent Hub —— Electron 主进程（**配置驱动，支持 N 个 agent**）
 *
 * 把多个 AI agent 接到同一张桌子上：对等中继，谁也不指挥谁。
 *
 * ★ 要接新 agent：改 `~/.agent-hub/config.json` 的 `agents`（或 app/agents.js），
 *   本文件不用动。
 *
 * 生命周期：
 *   打开窗口 → 起各 agent 自带的 app-server（如有）→ 起对等中继 → 界面显示
 *   关闭窗口 → 杀掉全部子进程 + 按端口兜底清理 → 退出
 *
 * ★ 本机差异（路径、代理）一律不写死，统一走 app/config.js：
 *     环境变量 → ~/.agent-hub/config.json → 自动探测 → 弹「设置」让用户自己填
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

const HERE = __dirname;
// 打包成 exe 后 HERE 位于 asar 内（只读），日志与配置必须改放用户目录
const RELAY_ROOT = app.isPackaged ? cfg.HOME_DIR : path.join(HERE, '..');
try { fs.mkdirSync(RELAY_ROOT, { recursive: true }); } catch (_) {}
const LOG_FILE = path.join(RELAY_ROOT, 'relay.log');
const ARCHIVE_FILE = path.join(RELAY_ROOT, 'relay.jsonl');
const WS_FILE = path.join(RELAY_ROOT, '.workspace');
const WB_SESSIONS = path.join(os.homedir(), '.workbuddy', 'sessions');

/* ---------- 环境定位：环境变量 → 配置 → 自动探测 → 空（交给用户填） ---------- */

/** 自动找 node：优先 WorkBuddy 自带的，其次 PATH */
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

/** 自动找 codex CLI（安装目录带 hash，不能写死） */
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

/* 代理：环境变量 → 配置 → 探测本机常见代理端口 → 不带代理
   为什么要有这一步：在中国大陆访问 Codex 通常要代理，但**端口每台机器都不一样**，
   以前写死了 127.0.0.1:7897（某一台机器的 Clash 端口），换个电脑就废。 */
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
  if (process.env.RELAY_PROXY) return { proxy: process.env.RELAY_PROXY, src: '环境变量 RELAY_PROXY' };
  const c = String(cfg.get('proxy') || '').trim();
  if (c) return { proxy: c, src: '配置文件' };
  for (const p of PROXY_PORTS) {
    if (await isPortOpen(p)) return { proxy: 'http://127.0.0.1:' + p, src: '自动探测' };
  }
  return { proxy: '', src: '无（未使用代理）' };
}

/** 临时目录 / 宿主目录都不是工作空间 —— 注意 `\Temp` 结尾没有斜杠也要算 */
function isTempPath(p) {
  return /[\\/](Temp|tmp|__workbuddy_cli_host__)([\\/]|$)/i.test(String(p || ''));
}

let AGENTS = [];
function loadAgents() {
  AGENTS = (cfg.get('agents') || []).filter((a) => a && a.id).map((a) => Object.assign({}, a));
  return AGENTS;
}
loadAgents();

// 源码版默认工作空间 = 仓库根（app 的上一级）；打包版没有「仓库」概念，用用户主目录兜底
const PROJECT_ROOT = app.isPackaged ? os.homedir() : path.resolve(HERE, '..');
const NODE = findNode();
const CODEX_CLI = findCodexCli();
const CWD = process.env.WB_CWD || PROJECT_ROOT;

/* ---------- 工作空间 ---------- */

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

/* ---------- 状态 ---------- */

let win = null;
let settingsWin = null;
const kids = [];
const wsOf = {};                 // agentId → 该 agent 的工作空间（每个可不同）
let quitting = false;
let relay = null;
let acpPorts = [];
let proxyInfo = { proxy: '', src: '' };

/* ---------- 往界面推 ---------- */

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

/** 把 agent 清单 + 工作空间列表 + 各 agent 状态推给界面 */
function pushWsList() {
  if (!win || win.isDestroyed()) return;
  const agents = AGENTS.filter((a) => a.enabled !== false).map((a) => ({
    id: a.id, name: a.name || a.id, color: a.color || '', cwd: wsOf[a.id] || '',
  }));
  const statuses = relay ? relay.status() : {};
  try { win.webContents.send('term-wslist', { agents, list: workspaces, statuses }); } catch (_) {}
}

/** 状态栏只报「连上了几个」，不堆细节（细节看灯） */
function refreshStatus(list) {
  const st = list || (relay ? relay.status() : {});
  const ids = Object.keys(st);
  const ready = ids.filter((k) => st[k] === 'ready').length;
  setStatus(ids.length ? `${ready}/${ids.length} 已连接` : '启动中…', st);
}

/* ---------- 进程管理 ---------- */

function spawnRaw(cmdline, tag) {
  const child = spawn(cmdline, [], { cwd: CWD, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(child);
  if (child.stdout) child.stdout.on('data', (d) => log(`[${tag}] ` + String(d).trimEnd()));
  if (child.stderr) child.stderr.on('data', (d) => log(`[${tag}!] ` + String(d).trimEnd()));
  child.on('exit', (c) => log(`${tag} 退出 code=${c}`));
  return child;
}

/** 按端口反查监听进程并杀 —— 服务可能 daemon 化，脱离 spawn 的进程树 */
function killByPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      if (line.indexOf('127.0.0.1:' + port) < 0 || line.indexOf('LISTENING') < 0) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) {
        push({ who: 'sys', text: '兜底清理监听进程 pid=' + pid });
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
  // 各 agent 自带的监听端口也要带走
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

/** 端口上有没有人在听（同步查一次） */
function portBusy(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return out.split('\n').some((l) => l.indexOf('127.0.0.1:' + port) >= 0 && l.indexOf('LISTENING') >= 0);
  } catch (_) { return false; }
}

/* ---------- 输入处理 ---------- */

function helpText() {
  return [
    '用法：底栏选「发给谁」+ 输入回车即可。以下是可选命令：',
    '  /ws            列出工作空间',
    '  /ws <编号|路径> 切换当前默认目标的工作空间',
    '  /t <agentId>   切换底栏默认目标',
    '  /status        看各 agent 状态',
    '  /clear         清屏',
    '  /help          看这条',
    '界面右上角的「设置」「清空留档」是按钮，点就行。',
  ].join('\n');
}

function targetOf() { return _target; }
function setTarget(id) { _target = id; }
let _target = null;

async function handleInput(text, to) {
  if (text === '/help') { log(helpText()); return; }
  if (text === '/clear') { push({ who: 'clear' }); return; }
  if (text === '/status') {
    log('各 agent 状态：' + JSON.stringify(relay ? relay.status() : {}));
    log('工作空间：' + JSON.stringify(wsOf));
    return;
  }
  if (text === '/ws' || text.startsWith('/ws ')) {
    const a = text.slice(3).trim();
    if (!a) { log('工作空间：'); workspaces.forEach((w, i) => log(`  ${i + 1}. ${w}`)); return; }
    const n = Number(a);
    const pick = (Number.isInteger(n) && n >= 1 && n <= workspaces.length) ? workspaces[n - 1] : a;
    if (!fs.existsSync(pick)) { log('路径不存在：' + pick); return; }
    await applyWs(targetOf() || (AGENTS[0] && AGENTS[0].id), pick);
    return;
  }
  if (text === '/t' || text.startsWith('/t ')) {
    const a = text.slice(2).trim();
    if (AGENTS.some((x) => x.id === a)) { setTarget(a); log('默认目标 → ' + a); pushWsList(); }
    else log('可选：' + AGENTS.map((x) => x.id).join(' / '));
    return;
  }

  const tgt = to || targetOf() || (AGENTS[0] && AGENTS[0].id);
  if (!relay || !relay.started) { log('中继未就绪，发不出去。看上面的启动日志。'); return; }
  push({ who: 'sys', text: `→ ${tgt}` });
  const r = await relay.send(tgt, text);
  if (!r.ok) log('发送失败：' + r.error);
}

/** 切换某个 agent 的工作空间 */
async function applyWs(agentId, p) {
  wsOf[agentId] = p;
  try { fs.writeFileSync(WS_FILE, p, 'utf8'); } catch (_) {}
  log(`${agentId} 工作空间 → ${p}`);
  if (relay && relay.started) {
    try { await relay.switchWs(agentId, p); } catch (e) { log('切换失败：' + e.message); }
  }
  pushWsList();
}

/* ---------- 主流程 ---------- */

async function boot() {
  log('=== Agent Hub 启动 ===');
  log(`设置文件：${cfg.FILE}${fs.existsSync(cfg.FILE) ? '' : '（还没有，用到时自动生成）'}`);
  log(`node = ${NODE || '(没找到 —— 可在「设置」里指定)'}`);

  proxyInfo = await resolveProxy();
  log(proxyInfo.proxy
    ? `代理 = ${proxyInfo.proxy}（来自：${proxyInfo.src}）`
    : '代理 = 不使用（Codex 若连不上，多半是这里要填，点右上角「设置」）');
  for (const a of AGENTS) {
    if (a.kind === 'codex-app-server') a.proxy = a.proxy || proxyInfo.proxy;
  }

  workspaces = listWorkspaces();
  const def = loadSavedWs();
  for (const a of AGENTS) wsOf[a.id] = def;
  log(`发现 ${workspaces.length} 个工作空间，默认：${def}`);
  pushWsList();

  // 0) 缺关键路径 → 直接把「设置」摆到用户面前，不让他去翻文档
  const needCodex = AGENTS.some((a) => a.enabled !== false && a.kind === 'codex-app-server');
  if (needCodex && !CODEX_CLI) {
    log('★ 没找到 Codex CLI —— 已打开「设置」窗口，选一下 codex.exe 的位置即可。');
    setTimeout(() => openSettings(), 700);
  }

  // 1) 起各 agent 自带的 app-server（配置里声明了 port 的）
  for (const a of AGENTS) {
    if (a.enabled === false) continue;
    if (a.kind !== 'codex-app-server' || !a.port) continue;
    if (!CODEX_CLI) { log(`${a.name} 跳过：没有 Codex CLI 路径`); continue; }
    const lf = path.join(RELAY_ROOT, a.id + '-app.log');
    const px = a.proxy || '';
    // ⚠️ 上次若是被强杀（任务管理器 / `taskkill /F`）退出的，app-server 子进程会活下来，
    //    占着端口不放。它同时还握着会话的写入权 —— 会让 Codex 客户端报
    //    「已在另一个应用中打开，请先在那边关闭会话」。所以起新的之前先把残留清掉。
    if (portBusy(a.port)) {
      log(`${a.name} 端口 ${a.port} 已被占用，先清掉上次留下的残留进程…`);
      killByPort(a.port);
      await new Promise((r) => setTimeout(r, 1000));
      if (quitting) return;
    }
    // ⚠️ codex 必须带代理，否则回合会一直卡在 inProgress
    const env = px
      ? `set "HTTPS_PROXY=${px}" && set "HTTP_PROXY=${px}" && set "ALL_PROXY=${px}" && `
      : '';
    log(`启动 ${a.name} 的 app-server…`);
    spawnRaw(`${env}"${CODEX_CLI}" app-server --listen ws://127.0.0.1:${a.port} > "${lf}" 2>&1`, a.id);
    const up = await waitPort(a.port, 30000);
    if (quitting) return;
    log(up ? `${a.name} app-server 就绪（:${a.port}）` : `${a.name} app-server 30 秒内未监听 ${a.port}`);
  }

  // 2) 发现 ACP 端口（WorkBuddy 这类，端口每次都可能变）
  log('发现 ACP 端口…');
  acpPorts = await discoverPorts();
  log(acpPorts.length ? '发现端口：' + acpPorts.join(', ') : '没发现可用的 ACP 端口');

  // 3) 起对等中继：所有 agent 同时接上，路由在中继里
  log('启动对等中继…');
  relay = new Relay({
    agents: AGENTS,
    cwd: def,
    cwds: wsOf,
    // ⚠️ 留档也要写用户目录：__dirname 在打包后位于 asar 内（只读），写不进去
    logFile: ARCHIVE_FILE,
  });
  relay.on('info', (m) => log(m));
  relay.on('delta', ({ from, text }) => push({ who: from, text }));
  relay.on('reasoning', ({ text }) => push({ who: 'sys', text: '· ' + text }));
  relay.on('turnDone', ({ from }) => log(`[${from} 本轮结束]`));
  relay.on('status', (s) => refreshStatus(s));

  try {
    const st = await relay.start();
    refreshStatus(st);
    log('各 agent 状态：' + JSON.stringify(st));
    log('底栏选「发给谁」+ 输入回车即可。');
    setTarget((AGENTS.find((a) => st[a.id] === 'ready') || AGENTS[0] || {}).id);
    pushWsList();
  } catch (e) {
    log('中继启动失败：' + e.message);
    setStatus('中继失败');
  }

  if (process.env.RELAY_SHOT === '1') {
    // 验收用：跑起来 → 截图 → 自动退出
    setTimeout(async () => {
      if (process.env.RELAY_SHOT_SETTINGS === '1') {
        openSettings();
        await new Promise((r) => setTimeout(r, 2500));
      }
      for (const [label, w, f] of [['主窗口', win, 'shot.png'], ['设置窗口', settingsWin, 'shot-settings.png']]) {
        if (!w || w.isDestroyed()) { log(`${label}截图跳过：窗口不存在`); continue; }
        try { w.show(); w.focus(); } catch (_) {}
        const r = await shoot(w.webContents, path.join(RELAY_ROOT, f));
        log(r === true ? `已截图 → ${f}` : (r ? `capturePage 不行，已改用打印管线 → ${String(f).replace(/\.png$/, '.pdf')}` : `${label}截图失败：环境拿不到画面`));
      }
      setTimeout(() => { quitting = true; killKids(); setTimeout(() => app.quit(), 800); }, 500);
    }, Number(process.env.RELAY_SHOT_DELAY) || 4000);
  }
}

/**
 * 截图：先试 capturePage（重试 3 次）。
 * ⚠️ 桌面锁屏 / 会话不可见时 Chromium 合成器会给 UnknownVizError —— 与是否打包无关。
 * 拿不到就退回打印管线（printToPDF），至少留一份能看的版式记录。
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

/* ---------- 窗口 ---------- */

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

/** 设置窗口：只干一件事 —— 让用户不用翻文档就能把路径/代理填对 */
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return settingsWin; }
  settingsWin = new BrowserWindow({
    width: 660,
    height: 660,
    title: 'Agent Hub · 设置',
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

ipcMain.on('term-send', (_e, payload) => {
  const text = typeof payload === 'string' ? payload : String((payload && payload.text) || '');
  const to = typeof payload === 'object' && payload ? payload.to : undefined;
  handleInput(text, to);
});

ipcMain.on('term-selectws', async (_e, d) => {
  if (!d || d.side === undefined || d.side === null || !d.path) return;
  await applyWs(d.side, d.path);
});

/** 清空留档（relay.jsonl）—— 二次确认，不可恢复 */
ipcMain.handle('log-clear', async () => {
  let lines = 0;
  try {
    if (fs.existsSync(ARCHIVE_FILE)) lines = fs.readFileSync(ARCHIVE_FILE, 'utf8').split('\n').filter(Boolean).length;
  } catch (_) {}
  const r = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    buttons: ['取消', '清空'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: '确定清空留档吗？',
    detail: `将清空 ${ARCHIVE_FILE} 中现有的 ${lines} 条记录，清空后不可恢复。\n（relay.log 运行日志不受影响）`,
  });
  if (r.response !== 1) return { ok: false, cancelled: true };
  try {
    fs.writeFileSync(ARCHIVE_FILE, '', 'utf8');
  } catch (e) {
    log('清空留档失败：' + e.message);
    return { ok: false, error: e.message };
  }
  log(`留档已清空（原有 ${lines} 条）→ ${ARCHIVE_FILE}`);
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
  if (r.ok) log('设置已保存 → ' + r.file + '（重启 Agent Hub 后生效）');
  else log('设置保存失败：' + r.error);
  return r;
});

ipcMain.handle('cfg-pick', async (_e, kind) => {
  const isNode = kind === 'node';
  const parent = (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : (win || undefined);
  const r = await dialog.showOpenDialog(parent, {
    title: isNode ? '选择 node.exe' : '选择 codex.exe',
    properties: ['openFile'],
    filters: [{ name: isNode ? 'node' : 'codex', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('cfg-detect', () => ({ ok: true, node: autoNode(), codexCli: autoCodexCli() }));

ipcMain.handle('cfg-restart', () => {
  log('按用户要求重启 Agent Hub…');
  quitting = true;
  killKids();
  setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
  return true;
});

ipcMain.on('cfg-close', () => { try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); } catch (_) {} });

/* ---------- 生命周期 ---------- */

app.whenReady().then(() => {
  createWindow();
  boot();
});

app.on('window-all-closed', () => { quitting = true; killKids(); app.quit(); });
app.on('before-quit', () => { quitting = true; killKids(); });
process.on('exit', killKids);
