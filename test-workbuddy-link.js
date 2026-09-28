#!/usr/bin/env node
/**
 * 连通性测试：WorkBuddy ACP ← workbuddy-link.js
 *
 * 前置：另开终端跑
 *   node "<WorkBuddy>/resources/app.asar.unpacked/cli/bin/codebuddy" --serve --port 8788 --auth none
 *
 * 要点：**正文在 POST /api/v1/acp 的响应流里**（agent_message_chunk），
 * 不在 GET 订阅流 —— 订阅流会把会话历史一并推来，当成正文会刷屏。
 *
 * 用法：
 *   node test-workbuddy-link.js
 *   WB_BASE=http://127.0.0.1:59533 RELAY_CWD=D:/某项目 node test-workbuddy-link.js
 */

'use strict';
const { WorkBuddyLink } = require('./app/workbuddy-link');

const BASE = process.env.WB_BASE || 'http://127.0.0.1:8788';
// 默认就用「当前所在目录」，不再写死某一台机器上的项目路径
const CWD = process.env.RELAY_CWD || process.cwd();

(async function main() {
  const link = new WorkBuddyLink(BASE);

  let body = '';
  let evtCount = 0;
  link.on('delta', (t) => { body += t; process.stdout.write(t); });
  link.on('event', (e) => {
    evtCount++;
    const u = e && e.params && e.params.update;
    const kind = u && u.sessionUpdate;
    console.log('\n[事件#' + evtCount + '] ' + (e.method || '?') + '  kind=' + kind + '  ' + JSON.stringify(e).slice(0, 260));
  });

  try {
    const c = await link.connect();
    console.log('[1] connect ok  connectionId=' + c.connectionId);

    const info = await link.init();
    console.log('[2] initialize ok  protocolVersion=' + (info && info.protocolVersion));

    await link.startEvents();
    console.log('[3] 已在 GET /api/v1/acp 上订阅事件流（仅用于看事件，不取正文）');

    const sid = await link.newSession(CWD);
    console.log('[4] 会话已建 sessionId=' + sid);

    console.log('[5] 发 prompt（正文从这里流出来）…');
    const res = await link.prompt('只回四个字：链路正常');
    console.log('\n[6] prompt 返回 status=' + res.status);

    await new Promise((r) => setTimeout(r, 3000));
    console.log('[7] 累积正文 ' + body.length + ' 字符：' + JSON.stringify(body.slice(0, 200)));

    await link.disconnect();
    process.exit(body ? 0 : 1);
  } catch (e) {
    console.error('[失败] ' + e.message);
    try { await link.disconnect(); } catch (_) {}
    process.exit(1);
  }
})();
