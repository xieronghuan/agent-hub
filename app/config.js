'use strict';
/**
 * app/config.js —— 本机设置（每台电脑各存各的，不进仓库）
 *
 * 存放位置（可用环境变量 AGENT_HUB_CONFIG 覆盖）：
 *   ~/.agent-hub/config.json
 *
 * 为什么要这个文件：路径（node / Codex CLI）、代理端口这些东西，
 * **每台电脑都不一样**，不能写死在源码里。程序启动时按下面的顺序找，
 * 一个都找不到就弹「设置」窗口让用户自己填 —— 不用看说明文档。
 *
 *   环境变量  →  config.json  →  自动探测  →  提示用户填
 *
 * 用户在界面上点「设置」改的就是这个文件，不需要手改。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_AGENTS = require('./agents');

const HOME_DIR = path.join(os.homedir(), '.agent-hub');
const FILE = process.env.AGENT_HUB_CONFIG || path.join(HOME_DIR, 'config.json');

const DEFAULTS = {
  // Paths: empty means "auto-detect"; you only fill these in when detection fails
  nodePath: '',
  codexCliPath: '',
  // Proxy: empty means "probe common local ports", then fall back to no proxy
  proxy: '',
  // UI language: 'auto' follows the OS locale, or force 'zh' / 'en'
  uiLang: 'auto',
  // Auto-relay: when you send to "Everyone", each agent's reply is passed on to
  // the others (bounded by autoRelayMaxHops rounds).
  autoRelay: true,
  // 最多转几轮。0 = 不限（只能靠 /stop 或对方的「谈完了」暗号停）。
  // 默认给 6：实测不限轮数时它们会互相发"待命""收到"这类空话停不下来。
  autoRelayMaxHops: 6,
  // Attach to the WorkBuddy conversation the desktop client already shows for a
  // folder, instead of a new session the client never lists.
  borrowClientSession: true,
  // Agents (falls back to app/agents.js when empty)
  agents: DEFAULT_AGENTS,
};

let cur = null;

function load() {
  if (cur) return cur;
  let fromFile = {};
  try { fromFile = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (_) {}
  cur = Object.assign({}, DEFAULTS, fromFile);
  if (!Array.isArray(cur.agents) || !cur.agents.length) cur.agents = DEFAULT_AGENTS;
  return cur;
}

function get(key) {
  const c = load();
  return key ? c[key] : c;
}

/** 合并写入；返回落盘位置，方便界面提示用户「存哪了」 */
function save(patch) {
  const next = Object.assign({}, load(), patch || {});
  cur = next;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, file: FILE };
  } catch (e) {
    return { ok: false, error: e.message, file: FILE };
  }
}

/** 进程内改内存副本（设置窗口保存后，主进程不用重启就能用新值） */
function reload() {
  cur = null;
  return load();
}

module.exports = { get, save, reload, FILE, HOME_DIR, DEFAULTS };
