#!/usr/bin/env node
/**
 * 原始报文调试：把 ACP 的 POST 响应体与 GET 订阅流原样打出来，不做任何解析。
 * 用途：搞清楚 session/prompt 的正文到底走哪条流、哪个字段。
 *
 * 用法：
 *   node debug-acp.js
 *   WB_BASE=http://127.0.0.1:59533 RELAY_CWD=D:/某项目 node debug-acp.js
 *
 * 响应体落盘到系统临时目录（不放进仓库）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.WB_BASE || 'http://127.0.0.1:8788';
const CWD = process.env.RELAY_CWD || process.cwd();

function log(...a) { console.log(...a); }

(async () => {
  const c = await (await fetch(BASE + '/api/v1/acp/connect', { method: 'POST' })).json();
  const H = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'acp-connection-id': c.connectionId,
  };
  log('connectionId = ' + c.connectionId);

  const initTxt = await (await fetch(BASE + '/api/v1/acp', {
    method: 'POST', headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
  })).text();
  log('initialize → ' + initTxt.replace(/\s+/g, ' ').slice(0, 120));

  const newTxt = await (await fetch(BASE + '/api/v1/acp', {
    method: 'POST', headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: CWD, mcpServers: [] } }),
  })).text();
  log('session/new 原始 → ' + newTxt.replace(/\s+/g, ' ').slice(0, 900));
  // 响应流里可能先混着 session/update，result 在后面 —— 要找含 result 的那条
  let sid = '';
  for (const line of newTxt.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const o = JSON.parse(t.slice(5).trim());
      if (o && o.result && (o.result.sessionId || o.result.session_id)) { sid = o.result.sessionId || o.result.session_id; break; }
      if (o && o.error) log('session/new 报错：' + JSON.stringify(o.error));
    } catch (_) {}
  }
  log('sessionId = ' + sid);

  // 订阅（后台）
  const sub = await fetch(BASE + '/api/v1/acp', { headers: H });
  log('订阅 HTTP ' + sub.status);
  (async () => {
    const rd = sub.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) { log('\n########## 订阅流结束 ##########'); break; }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('data:')) log('\n[订阅] ' + t.slice(5).trim().slice(0, 600));
        else if (t) log('\n[订阅-行] ' + t.slice(0, 120));
      }
    }
  })();

  log('\n########## session/prompt 的 POST 响应体 ##########');
  const r = await fetch(BASE + '/api/v1/acp', {
    method: 'POST', headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: '只回四个字：链路正常' }] } }),
  });
  log('HTTP ' + r.status);
  const t = await r.text();
  const out = path.join(os.tmpdir(), 'agent-hub-post-body.txt');
  fs.writeFileSync(out, t, 'utf8');
  log('响应体已落盘 ' + out + '（' + t.length + ' 字节）');

  // 逐条列出 data: 行里的 method 与关键结构（不做窄过滤）
  const kinds = {};
  for (const line of t.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    try {
      const o = JSON.parse(s.slice(5).trim());
      const key = (o.method || 'response') + (o.params && o.params.update ? ' / ' + o.params.update.sessionUpdate : '');
      kinds[key] = (kinds[key] || 0) + 1;
    } catch (_) { kinds['<解析失败>'] = (kinds['<解析失败>'] || 0) + 1; }
  }
  log('--- POST 响应体里的条目分布 ---');
  Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a]).forEach((k) => log('  ' + kinds[k] + '  ' + k));
  log('########## POST 响应体结束 ##########');

  await new Promise((r2) => setTimeout(r2, 10000));
  process.exit(0);
})();
