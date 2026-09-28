#!/usr/bin/env node
/**
 * codex/relay/discover.js —— 动态发现可用的 WorkBuddy ACP 端口
 *
 * 为什么需要：ACP 端口**每次启动都可能变**（CLI host 尤其如此），
 * 写死端口迟早会失效。做法与 `codex/bus/acp.js` 一致：
 *   1. 从 ~/.workbuddy/sessions/*.json 收集候选端口
 *   2. 补上 netstat 里 127.0.0.1 的 LISTENING 端口
 *   3. 逐个 GET / 认 "CodeBuddy Remote Control" 特征（**不建立 ACP 连接**，不占配额）
 *
 * 端口探测不占用 ACP 连接 —— 这点很重要，ACP 有 maxConnections 限制。
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const SESSION_DIR = path.join(os.homedir(), '.workbuddy', 'sessions');
const MARKER = 'CodeBuddy Remote Control';

function candidatePorts() {
  const ports = new Set();
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
        for (const k of ['endpoint', 'url']) {
          const m = /:(\d+)\s*$/.exec(String(j[k] || ''));
          if (m) ports.add(Number(m[1]));
        }
      } catch (_) {}
    }
  } catch (_) {}
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      const m = /TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
  } catch (_) {}
  return Array.from(ports);
}

async function probe(port, timeoutMs) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(timeoutMs || 900) });
    if (!r.ok) return false;
    const t = await r.text();
    return t.indexOf(MARKER) >= 0;
  } catch (_) { return false; }
}

/** 返回所有活着的 ACP 端口（升序） */
async function discoverPorts() {
  const cands = candidatePorts();
  const hits = await Promise.all(cands.map(async (p) => ((await probe(p)) ? p : null)));
  return hits.filter(Boolean).sort((a, b) => a - b);
}

/**
 * 端口 → 那条会话的工作目录（同一端口取心跳最新的一条）。
 *
 * 为什么要这个：WorkBuddy 的 ACP 有多个入口，其中一个是 CLI host，
 * **它自己的进程就在临时目录里**。连到它，agent 看到的工作目录就是临时目录，
 * 跟用户在界面上选的目录对不上。有了这张表就能优先挑"目录对得上"的入口。
 */
function portHints() {
  const out = {};
  const stamp = {};
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
        const m = /:(\d+)\s*$/.exec(String(j.endpoint || j.url || ''));
        const cwd = j.cwd;
        if (!m || !cwd) continue;
        const port = m[1];
        const hb = j.lastHeartbeat || 0;
        if (!(port in out) || hb > (stamp[port] || 0)) { out[port] = cwd; stamp[port] = hb; }
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

/**
 * 挑一个用于「后台会话」的 ACP 端口。
 * 排除桌面端会话端口（那些注进去会变成用户可见的前台消息，不适合后台任务）。
 * 做法：把候选按「是否等于给定的排除列表」过滤，剩下的取第一个。
 */
async function pickBackendPort(excludePorts) {
  const ex = (excludePorts || []).map(Number);
  const all = await discoverPorts();
  const left = all.filter((p) => ex.indexOf(p) < 0);
  return left.length ? left[0] : (all[0] || null);
}

module.exports = { discoverPorts, pickBackendPort, probe, portHints };
