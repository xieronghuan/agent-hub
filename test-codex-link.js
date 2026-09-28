#!/usr/bin/env node
/**
 * 连通性测试：codex app-server ← relay.js
 *
 * 前置：另开一个终端跑
 *   codex app-server --listen ws://127.0.0.1:8899
 *
 * 本脚本主动用 sandbox=read-only 建会话，避免测试期间真去改文件。
 *
 * 用法：
 *   node test-codex-link.js
 *   CODEX_WS=ws://127.0.0.1:9999 RELAY_CWD=D:/某项目 node test-codex-link.js
 */

'use strict';
const { CodexLink } = require('./app/relay');
const AGENTS = require('./app/agents');

const codexLeg = AGENTS.find((a) => a.kind === 'codex-app-server') || {};
const URL = process.env.CODEX_WS || `ws://127.0.0.1:${codexLeg.port || 8899}`;
// 默认就用「当前所在目录」，不再写死某一台机器上的项目路径
const CWD = process.env.RELAY_CWD || process.cwd();

(async function main() {
  const link = new CodexLink(URL);

  let body = '';
  link.on('delta', (t) => { body += t; process.stdout.write(t); });
  link.on('reasoning', (t) => process.stderr.write('·' + t));
  link.on('turnStarted', () => console.log('\n[turn 开始]'));
  link.on('turnDone', () => console.log('\n[turn 结束]'));
  link.on('close', () => console.log('[连接关闭]'));
  link.on('event', (m, p) => {
    if (/mcpServer\/startupStatus/.test(m)) return;          // 噪音，跳过
    if (/agentMessage\/delta|reasoning/.test(m)) return;     // 已单独处理
    console.log('[事件] ' + m + '  ' + JSON.stringify(p).slice(0, 400));
  });

  try {
    await link.connect();
    console.log('[1] WebSocket 已连接 ' + URL);

    const info = await link.init();
    console.log('[2] initialize ok：' + JSON.stringify(info).slice(0, 140));

    const tid = await link.startThread(CWD, { sandbox: 'read-only' });
    console.log('[3] 会话已建 threadId=' + tid);

    console.log('[4] 发送 turn…');
    await link.say('只回四个字：链路正常');

    // 账号状态（判断是否有可用凭据 —— 没登录时回合会一直卡在 inProgress）
    try {
      const acct = await link.rpc('account/read', {}, 8000);
      console.log('[5] account/read：' + JSON.stringify(acct).slice(0, 300));
    } catch (e) {
      console.log('[5] account/read 失败：' + e.message);
    }

    const waitMs = Number(process.env.RELAY_WAIT) || 25000;
    console.log('[6] 等待 ' + (waitMs / 1000) + ' 秒…');
    await new Promise((r) => setTimeout(r, waitMs));

    console.log('\n[结果] 收到正文 ' + body.length + ' 字符：' + JSON.stringify(body.slice(0, 120)));
    link.close();
    process.exit(body ? 0 : 1);
  } catch (e) {
    console.error('[失败] ' + e.message);
    link.close();
    process.exit(1);
  }
})();
