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
  // 路径类：一律留空表示「自动探测」，探测不到才让用户填
  nodePath: '',
  codexCliPath: '',
  // 代理：留空表示「自动探测本机常见端口」，再不行就不带代理启动
  proxy: '',
  // 各条腿（不填则用 app/agents.js 的内置默认）
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
