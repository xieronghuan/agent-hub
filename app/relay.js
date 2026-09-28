#!/usr/bin/env node
/**
 * codex/bus/relay.js —— codex ⇄ WorkBuddy 中继（第一阶段：codex 侧已通）
 *
 * 定位：两侧各一条长连接，不做轮询。
 *   codex app-server  ← ws + JSON-RPC →  本模块  ← HTTP + ACP/SSE →  WorkBuddy
 *
 * 协议来自 `codex app-server generate-json-schema`（见 codex-schema/），要点：
 *   请求：initialize → thread/start|thread/resume → turn/start|turn/steer|turn/interrupt
 *   事件：item/agentMessage/delta（正文流）、item/reasoning/*（思考）、
 *         item/commandExecution/outputDelta、turn/started、turn/completed
 *
 * Node 22 内置 WebSocket，本模块零依赖。
 */

'use strict';
const EventEmitter = require('events');

class CodexLink extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threadId = null;
    this.ready = false;
    this._closed = false;
  }

  /* ---------- 连接 ---------- */

  connect(timeoutMs) {
    const limit = timeoutMs || 8000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('连接超时：' + this.url));
      }, limit);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('连接失败：' + this.url));
      };
      ws.onmessage = (ev) => this._onMessage(String(ev.data));
      ws.onclose = () => {
        this.ready = false;
        if (!this._closed) this.emit('close');
      };
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    // 响应
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    // 通知（服务端推事件）
    const method = msg.method || '';
    const params = msg.params || {};
    if (!method) return;
    this.emit('event', method, params);

    switch (method) {
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') this.emit('delta', params.delta, params);
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        if (typeof params.delta === 'string') this.emit('reasoning', params.delta, params);
        break;
      case 'item/commandExecution/outputDelta':
        if (typeof params.delta === 'string') this.emit('commandOutput', params.delta, params);
        break;
      case 'turn/started':
        this.emit('turnStarted', params);
        break;
      case 'turn/completed':
        this.emit('turnDone', params);
        break;
      default:
        break;
    }
  }

  /* ---------- 请求 ---------- */

  rpc(method, params, timeoutMs) {
    const limit = timeoutMs || 30000;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { reject(new Error('未连接')); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('超时：' + method));
        }
      }, limit);
    });
  }

  /* ---------- 语义化封装 ---------- */

  /** 单向通知（不带 id，等不到响应） */
  notify(method, params) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }));
  }

  async init() {
    const r = await this.rpc('initialize', { clientInfo: { name: 'relay', version: '0.1' } });
    // 协议要求：initialize 之后客户端必须回一个 initialized 通知，否则服务端不往前推进
    this.notify('initialized', {});
    this.ready = true;
    return r;
  }

  /** 新建会话；opts 可带 sandbox / approvalPolicy / model 等（见 ThreadStartParams） */
  async startThread(cwd, opts) {
    const params = Object.assign({}, opts || {});
    if (cwd) params.cwd = cwd;
    const r = await this.rpc('thread/start', params);
    const id = (r && (r.threadId || (r.thread && r.thread.id) || (r.thread && r.thread.threadId))) || null;
    if (!id) throw new Error('thread/start 未返回 threadId，原始返回：' + JSON.stringify(r).slice(0, 300));
    this.threadId = id;
    return id;
  }

  /** 接续已有会话 */
  async resumeThread(threadId) {
    const r = await this.rpc('thread/resume', { threadId });
    this.threadId = threadId;
    return r;
  }

  /** 发一轮消息。立即返回 turnId；正文通过 delta 事件流出 */
  async say(text) {
    if (!this.threadId) throw new Error('还没有会话，先 startThread()');
    return this.rpc('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: String(text) }],
    }, 15000);
  }

  /** 给正在跑的回合插话（实时转向） */
  async steer(text) {
    if (!this.threadId) throw new Error('还没有会话');
    return this.rpc('turn/steer', {
      threadId: this.threadId,
      input: [{ type: 'text', text: String(text) }],
    }, 15000);
  }

  async interrupt() {
    if (!this.threadId) return;
    return this.rpc('turn/interrupt', { threadId: this.threadId }, 10000);
  }

  async listThreads() {
    return this.rpc('thread/list', {}, 15000);
  }

  close() {
    this._closed = true;
    try { this.ws && this.ws.close(); } catch (_) {}
    this.ready = false;
  }
}

module.exports = { CodexLink };
