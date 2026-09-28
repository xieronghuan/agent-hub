#!/usr/bin/env node
/**
 * 对等中继端到端测试：把所有启用的腿都连上，各发一句。
 *
 * 前置：各条腿对应的服务已在跑（见 app/agents.js 里的 kind / port）
 *   codex：codex app-server --listen ws://127.0.0.1:8899   （且要带代理，否则回合会卡在 inProgress）
 *   WorkBuddy：桌面端 / CLI host 的 ACP 在监听（端口每次可能变，由 discover.js 自动发现）
 *
 * 用法：
 *   node test-relay.js
 *   RELAY_CWD=D:/某项目 RELAY_WAIT=20000 node test-relay.js
 */

'use strict';
const { Relay } = require('./app/relay-server');
const AGENTS = require('./app/agents');

// 默认就用「当前所在目录」，不再写死某一台机器上的项目路径
const CWD = process.env.RELAY_CWD || process.cwd();
const WAIT = Number(process.env.RELAY_WAIT) || 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const ids = AGENTS.filter((a) => a.enabled !== false).map((a) => a.id);
  const r = new Relay({ agents: AGENTS, cwd: CWD, cwds: {} });
  const got = {};
  ids.forEach((i) => { got[i] = ''; });

  r.on('info', (m) => console.log('[中继] ' + m));
  r.on('delta', ({ from, text }) => { got[from] += text; process.stdout.write('\n[' + from + '] ' + text); });
  r.on('turnDone', ({ from }) => console.log('\n[' + from + ' 本轮结束]'));

  await r.start();
  console.log('状态：' + JSON.stringify(r.status()));
  console.log('工作空间：' + CWD);

  for (const id of ids) {
    console.log('\n===== 发给 ' + id + ' =====');
    const a = await r.send(id, '只回四个字：链路正常');
    console.log('send → ' + JSON.stringify({ ok: a.ok, error: a.error }));
    await sleep(WAIT);
  }

  console.log('\n===== 汇总 =====');
  for (const id of ids) console.log(id.padEnd(12) + '收到：' + JSON.stringify(got[id].slice(0, 80)));

  r.close();
  process.exit(ids.every((i) => got[i]) ? 0 : 1);
})();
