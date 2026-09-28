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
    // 当前模型：thread/start 的返回里带（服务端默认值），之后用户可以换
    this.model = null;
    this.modelProvider = null;
    // 可选模型（model/list 的结果），启动时拉一次缓存下来
    this.models = [];
  }

  /* ---------- 模型 ---------- */

  /** 拉一份可选模型列表（model/list）。老版本 codex 没这个方法，会走 catch。 */
  async loadModels() {
    const r = await this.rpc('model/list', { limit: 200 }, 20000);
    const data = (r && r.data) || [];
    this.models = data
      .filter((m) => m && (m.id || m.model) && !m.hidden)
      .map((m) => ({
        value: m.id || m.model,
        name: m.displayName || m.id || m.model,
        // 每个模型支持哪些强度是**随模型变的**，所以跟模型一起存
        efforts: (m.supportedReasoningEfforts || []).map((e) => ({
          value: e.reasoningEffort,
          name: e.reasoningEffort,
          description: e.description || '',
        })),
        defaultEffort: m.defaultReasoningEffort || '',
      }));
    return this.models;
  }

  /** 当前模型，形如 { value:'gpt-5.6-sol', label:'GPT-5.6-Sol' }；没有就 null */
  currentModel() {
    if (!this.model) return null;
    const m = this.models.find((x) => x.value === this.model);
    return { value: this.model, label: (m && m.name) || this.model };
  }

  modelChoices() { return this.models.map((m) => ({ value: m.value, name: m.name })); }

  _modelEntry(id) { return this.models.find((x) => x.value === (id || this.model)) || null; }

  /** 当前强度 + 这个模型支持哪些强度（低/中/高/极高/最高/Ultra） */
  effortInfo() {
    const entry = this._modelEntry();
    const choices = (entry && entry.efforts) || [];
    if (!choices.length) return null;
    const cur = choices.find((c) => c.value === this.effort) || choices.find((c) => c.value === entry.defaultEffort) || choices[0];
    return { value: cur.value, label: cur.name, choices };
  }

  /**
   * 换模型 / 换强度。Codex 这两样都是**按轮**传的（turn/start 的 params.model / params.effort），
   * 所以这里只记住，下一轮说的时候带上 —— 不用重开会话，上下文不丢。
   *
   * 已实测确认真的生效：用 codex 自己的落盘记录核验过
   * （~/.codex/sessions 下的 rollout-*.jsonl，那轮的 turn_context 里 model 和 effort 都对得上）。
   */
  async setConfigOption(configId, value) {
    if (configId === 'model') {
      this.model = value;
      // 换了模型，强度可选项跟着变；旧的不被新模型支持就退回新模型的默认值，
      // 不然会把一个无效强度发上去
      const entry = this._modelEntry(value);
      const ok = entry && (entry.efforts || []).some((e) => e.value === this.effort);
      if (!ok) this.effort = (entry && entry.defaultEffort) || ((entry && entry.efforts[0] || {}).value) || null;
      return this.currentModel();
    }
    if (configId === 'effort') {
      const info = this.effortInfo();
      if (!info || !info.choices.some((c) => c.value === value)) return info;
      this.effort = value;
      return this.effortInfo();
    }
    return null;
  }

  /** 设置项的通用读取：中继统一按 configId 问，两条腿各自实现 */
  configInfo() {
    const model = this.currentModel();
    const effort = this.effortInfo();
    const out = {};
    if (model) out.model = { value: model.value, label: model.label, choices: this.modelChoices() };
    if (effort) out.effort = { value: effort.value, label: effort.label, choices: effort.choices };
    return out;
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
    // 用户已经选过模型的话，新会话也用它（服务端返回的才是最终生效的那个）
    if (this.model && !params.model) params.model = this.model;
    const r = await this.rpc('thread/start', params);
    if (r && r.model) { this.model = r.model; this.modelProvider = r.modelProvider || null; }
    if (r && r.reasoningEffort) this.effort = r.reasoningEffort;
    const id = (r && (r.threadId || (r.thread && r.thread.id) || (r.thread && r.thread.threadId))) || null;
    if (!id) throw new Error('thread/start 未返回 threadId，原始返回：' + JSON.stringify(r).slice(0, 300));
    this.threadId = id;
    return id;
  }

  /** 接续已有会话；顺手把服务端记着的模型/强度接回来，免得界面显示成默认值 */
  async resumeThread(threadId) {
    // excludeTurns：只要会话本身，不要历史轮次（历史在客户端那边读，这里用不上）
    const r = await this.rpc('thread/resume', { threadId, excludeTurns: true }, 30000);
    this.threadId = threadId;
    const th = (r && r.thread) || {};
    const model = (r && r.model) || th.model;
    if (model) this.model = model;
    const eff = (r && r.reasoningEffort) || th.reasoningEffort;
    if (eff) this.effort = eff;
    return r;
  }

  /**
   * 按目录找**最近用过的那条**会话。
   *
   * 为什么需要：以前每次启动都无条件 thread/start，于是每开一次程序，
   * Codex 客户端里就多出一条对话（2026-09-28 用户反馈「它每回一条消息就新建个对话」）。
   * WorkBuddy 那边一直是借用客户端已有的会话，Codex 这边补齐。
   *
   * thread/list 的返回是 { data: [...] }，每项有 id / cwd / updatedAt / source / preview。
   */
  async findRecentThread(cwd) {
    const p = { limit: 20, sortKey: 'updated_at', sortDirection: 'desc', archived: false };
    if (cwd) p.cwd = cwd;
    const r = await this.rpc('thread/list', p, 20000);
    const arr = (r && r.data) || [];
    const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const want = norm(cwd);
    const hit = arr.find((x) => x && x.id && (!want || norm(x.cwd) === want));
    return hit ? hit.id : null;
  }

  /** 发一轮消息。立即返回 turnId；正文通过 delta 事件流出 */
  async say(text) {
    if (!this.threadId) throw new Error('还没有会话，先 startThread()');
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text: String(text) }],
    };
    // 模型和强度都是按轮传的：用户换过就带上，没换过就用服务端默认
    if (this.model) params.model = this.model;
    if (this.effort) params.effort = this.effort;
    return this.rpc('turn/start', params, 15000);
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
