'use strict';
/**
 * app/wb-host.js —— 在**指定目录**下起一个 WorkBuddy 后端。
 *
 * 为什么必须自己起：后端干活的目录是**启动时**定下来的 ——
 *   `--settings` 里的 `trustedDirectories`（mcp-config 里还有一份 CODEBUDDY_PROJECT_DIR）。
 * `session/new` 的 cwd 参数它不认（实测：传了别的目录，它照样在自己的目录里干活）。
 * 客户端起的那些后端，目录跟着「客户端打开的项目」走，中继里选的目录它根本不看。
 * 自己起 —— 在哪个目录起，它就在哪个目录干活。
 *
 * ⚠️ 两个坑：
 *   ① 要用 **node.exe 去跑那个 cli 脚本**（`<node> <cli> --serve …`）。
 *      用 `WorkBuddy.exe <cli> …` 包着起是错的 —— 那样起不来（0.9 秒就退出）。
 *   ② **不要**加 `--no-session-persistence`：要让它把会话落库，
 *      客户端的会话列表才看得到（配合 wb-sessions.js 的 registerSession）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** cli 脚本在 WorkBuddy 安装目录里的相对位置 */
const CLI_REL = path.join('WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

/**
 * 找 codebuddy CLI。装哪个盘不一定，所以按盘符扫 ——
 * 这套逻辑照抄项目里那个「登录WorkBuddyCLI.cmd」，别自己另发明一套。
 */
function findCli(cfg) {
  const fromEnv = process.env.WB_CLI;
  if (exists(fromEnv)) return fromEnv;

  const fromCfg = (cfg && typeof cfg.get === 'function') ? String(cfg.get('workbuddyCliPath') || '') : '';
  if (exists(fromCfg)) return fromCfg;

  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    const p = d + ':\\' + CLI_REL;
    if (exists(p)) return p;
  }
  return '';
}

/** 起进程；端口交给它自己选（--port 0），我们从它的输出里读回来 */
function spawnHost(o) {
  const settings = JSON.stringify({
    sandbox: { enabled: false },
    trustedDirectories: [String(o.cwd).replace(/\\/g, '/') + '/**'],
  });
  const env = Object.assign({}, process.env);
  const px = o.proxy || '';
  if (px) { env.HTTPS_PROXY = px; env.HTTP_PROXY = px; env.ALL_PROXY = px; }

  // ⚠️ `--permission-mode fullAccess` 不能少：不传的话它按默认权限模式跑，
  //    要动手时会停在"等审批"，而没有界面给它批 —— 表现就是「本轮结束但一个字都没有」。
  // 数组传参：路径和 JSON 里都有引号，拼字符串必出事
  return spawn(o.node, [
    o.cli, '--serve', '--port', '0',
    '--setting-sources', 'user',       // 和客户端起后端时一致：读用户级的配置/凭据
    '--permission-mode', 'fullAccess',
    '--settings', settings,
  ], {
    cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
}

/** 从它的输出里等出 `Endpoint http://127.0.0.1:PORT` */
function waitEndpoint(child, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    const t0 = Date.now();
    const take = () => {
      const m = /Endpoint\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      return m ? m[1] : '';
    };
    const timer = setInterval(() => {
      const p = take();
      if (p) { clearInterval(timer); resolve(p); return; }
      if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(''); }
    }, 400);
    const onData = (d) => { buf += String(d); if (buf.length > 20000) buf = buf.slice(-8000); };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('exit', () => { setTimeout(() => { clearInterval(timer); resolve(take()); }, 200); });
  });
}

/**
 * 在 cwd 下起一个后端并等它报出端口。
 * @param {{cfg:object, cwd:string, node:string, proxy?:string, timeoutMs?:number, cli?:string}} o
 * @returns {Promise<null|{base:string, child:object, cli:string, node:string}>}
 */
async function launchHost(o) {
  const cli = o.cli || findCli(o.cfg);
  const node = o.node || '';
  if (!cli || !node) return null;

  const child = spawnHost({ node, cli, cwd: o.cwd, proxy: o.proxy });
  const port = await waitEndpoint(child, o.timeoutMs || 40000);
  if (!port) {
    try { child.kill(); } catch (_) {}
    return null;
  }
  return { base: 'http://127.0.0.1:' + port, child, cli, node };
}

module.exports = { findCli, launchHost };
