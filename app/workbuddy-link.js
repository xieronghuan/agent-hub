#!/usr/bin/env node
/**
 * codex/bus/workbuddy-link.js —— 中继里对接 WorkBuddy 的那一端
 *
 * WorkBuddy 侧提供的是 HTTP + ACP（JSON-RPC over HTTP，事件走 SSE）。
 * 本模块把它包装成与 CodexLink 对称的接口，供中继做对等路由。
 *
 * 协议（均已实测）：
 *   POST /api/v1/acp/connect          → { connectionId, sessionToken }
 *   POST /api/v1/acp  (JSON-RPC)      → initialize / session/new / session/load / session/prompt
 *   GET  /api/v1/acp                  → SSE 事件流
 *   DELETE /api/v1/acp                → 断开
 *
 * 必须带的两个 header：
 *   acp-connection-id: <connectionId>
 *   Accept: application/json, text/event-stream     ← 少这个会 406
 *
 * ⚠️ initialize 必须最先发，否则其余方法一律返回 "Server not initialized"。
 */

'use strict';
const EventEmitter = require('events');

class WorkBuddyLink extends EventEmitter {
  /** @param {string} baseUrl 形如 http://127.0.0.1:8788 */
  constructor(baseUrl) {
    super();
    this.base = String(baseUrl || '').replace(/\/+$/, '');
    this.conn = null;
    this.sessionId = null;
    this.nextId = 1;
    this.ready = false;
    this._sseAbort = null;
    // 会话设置（模型 / 思考等级 / 权限模式…），来自 ACP 的 config_option_update 事件。
    // 每项形如 { id, name, currentValue, options:[{value,name}] }
    this.configOptions = [];
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'acp-connection-id': this.conn ? this.conn.connectionId : '',
    };
  }

  /* ---------- 连接与握手 ---------- */

  async connect() {
    const r = await fetch(this.base + '/api/v1/acp/connect', { method: 'POST' });
    if (!r.ok) throw new Error('ACP connect HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.connectionId) throw new Error('connect 未返回 connectionId');
    this.conn = j;
    return j;
  }

  /** ACP 要求先 initialize，否则后续一律 "Server not initialized" */
  async init() {
    const res = await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (res.status !== 200) throw new Error('initialize HTTP ' + res.status);
    this.ready = true;
    return res.result;
  }

  /* ---------- JSON-RPC ---------- */

  async rpc(method, params, timeoutMs) {
    const limit = timeoutMs || 30000;
    const id = this.nextId++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limit);
    try {
      const r = await fetch(this.base + '/api/v1/acp', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
        signal: ctl.signal,
      });
      const txt = await r.text();
      const events = WorkBuddyLink.parseSse(txt);
      const first = events.find((e) => e && (e.result !== undefined || e.error)) || events[0] || null;
      return {
        id, status: r.status, events,
        result: first && first.result !== undefined ? first.result : null,
        error: first && first.error ? first.error : null,
      };
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      return { id, status: 0, events: [], result: null, error: { message: timedOut ? 'timeout' : String(e.message || e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  static parseSse(txt) {
    const out = [];
    for (const line of String(txt).split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (!d) continue;
      try { out.push(JSON.parse(d)); } catch (_) {}
    }
    return out;
  }

  /* ---------- 会话设置（模型等） ---------- */

  /** 从一批事件里抽出 config_option_update 携带的设置列表 */
  static parseConfigOptions(events) {
    let out = null;
    for (const evt of events || []) {
      const u = (evt && evt.params && evt.params.update) || {};
      if (u.sessionUpdate !== 'config_option_update') continue;
      out = Array.isArray(u.configOptions) ? u.configOptions : (out || []);
    }
    return out;
  }

  /** 收到设置变更事件就更新缓存（开新会话、切会话、改设置都会带这个事件） */
  _absorbConfigOptions(events) {
    const o = WorkBuddyLink.parseConfigOptions(events);
    if (o) this.configOptions = o;
  }

  /** 当前设置项，如 currentModel('model') → { value, label }；找不到返回 null */
  configValue(configId) {
    const o = (this.configOptions || []).find((c) => c.id === configId);
    if (!o) return null;
    const opt = (o.options || []).find((x) => x.value === o.currentValue);
    return { value: o.currentValue, label: (opt && opt.name) || o.currentValue };
  }

  /** 当前用的模型，如 { value:'deepseek-v4.1-flash', label:'Deepseek V4.1 Flash' } */
  currentModel() { return this.configValue('model'); }

  /** 可选的模型列表 [{ value, name }] */
  modelChoices() {
    const o = (this.configOptions || []).find((c) => c.id === 'model');
    return o && Array.isArray(o.options) ? o.options : [];
  }

  /**
   * 思考强度。ACP 这边的设置名叫 thought_level
   * （Minimal / Low / Medium / High / X-High / Max / On）。
   * 万一以后改名，就按"id 里带这些词"兜一下，别写死一个字符串。
   */
  _effortOption() {
    const list = this.configOptions || [];
    return list.find((c) => c.id === 'thought_level')
      || list.find((c) => /thought|effort|reasoning/i.test(c.id || ''))
      || null;
  }

  effortInfo() {
    const o = this._effortOption();
    if (!o) return null;
    const choices = (o.options || []).map((x) => ({ value: x.value, name: x.name, description: x.description || '' }));
    const cur = choices.find((c) => c.value === o.currentValue) || choices[0];
    if (!cur) return null;
    return { value: cur.value, label: cur.name, choices };
  }

  /** 中继统一按 configId 向两条腿要设置项 */
  configInfo() {
    const out = {};
    const m = this.currentModel();
    if (m) out.model = { value: m.value, label: m.label, choices: this.modelChoices() };
    const e = this.effortInfo();
    if (e) out.effort = { value: e.value, label: e.label, choices: e.choices };
    return out;
  }

  /**
   * 改一个会话设置。实测可用的方法是 session/set_config_option
   * —— session/setConfigOption、set_option 都不存在。
   * 成功后主机回推 config_option_update，缓存随之更新。
   *
   * 对外统一叫 'model' / 'effort'，ACP 这边真实的 id 是 model / thought_level，
   * 在这里翻译一次，免得调用方去记两套名字。
   */
  async setConfigOption(configId, value) {
    if (!this.sessionId) throw new Error('还没有会话');
    let realId = configId;
    if (configId === 'effort') {
      const o = this._effortOption();
      if (!o) return null;
      realId = o.id;
    }
    const res = await this.rpc('session/set_config_option', { sessionId: this.sessionId, configId: realId, value });
    this._absorbConfigOptions(res.events);
    if (res.error) throw new Error('set_config_option 报错：' + JSON.stringify(res.error).slice(0, 200));
    return configId === 'effort' ? this.effortInfo() : this.configValue(realId);
  }

  /* ---------- 会话 ---------- */

  async newSession(cwd) {
    // ACP 强制要求 mcpServers 字段存在（哪怕是空数组），少传会 -32602 Invalid params
    const params = { mcpServers: [] };
    if (cwd) params.cwd = cwd;
    const res = await this.rpc('session/new', params);
    const id = res.result && (res.result.sessionId || res.result.session_id);
    if (!id) throw new Error('session/new 未返回 sessionId：' + JSON.stringify(res.result || res.error));
    this.sessionId = id;
    this._absorbConfigOptions(res.events);
    return id;
  }

  /**
   * 接进一条已有会话（"借用"客户端正在用的那条）。
   *
   * ⚠️ 这台主机**不回显 sessionId**：`session/load` 的 result 是个模型列表
   * （`{"models":{"availableModels":[…]}}`），没有 error，也看不出到底加载没有。
   * 所以：只要没报错就沿用它，但把 `unconfirmed` 标出来让上层提示 ——
   * 宁可说"未确认"，也不要假装肯定，更不要因为拿不到 id 就把这条唯一的通路丢掉。
   */
  async loadSession(sessionId, cwd) {
    const res = await this.rpc('session/load', { sessionId, cwd: cwd || undefined, mcpServers: [] });
    if (res.error) throw new Error('session/load 报错：' + JSON.stringify(res.error).slice(0, 200));
    const id = res.result && (res.result.sessionId || res.result.session_id);
    this.sessionId = id || sessionId;
    this.loadUnconfirmed = !id;
    this._absorbConfigOptions(res.events);
    return this.sessionId;
  }

  /**
   * 发一条 prompt 并接收正文。
   *
   * ⚠️ POST 的响应体是**整段会话记录**（实测 171KB，含几小时前的旧轮次），
   * 不是只有这次的新内容。所以先收集，最后只取「最后一轮」的片段（见 extractTurn）。
   *
   * 代价：ACP 这条腿的正文是**整段一次性出现**，不再逐字流式。
   * 换来的是不会再把旧会话内容刷到界面上 —— 宁可不流式，也不能显示错的。
   * 返回本轮正文。
   */
  async prompt(text, onDelta) {
    if (!this.sessionId) throw new Error('还没有会话');
    const id = this.nextId++;
    const body = {
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: { sessionId: this.sessionId, prompt: [{ type: 'text', text: String(text) }] },
    };
    const r = await fetch(this.base + '/api/v1/acp', { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!r.ok || !r.body) return { status: r.status, text: '' };

    const reader = r.body.getReader();
    const dec = new TextDecoder('utf-8');
    const pieces = [];
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (!d) continue;
        let evt;
        try { evt = JSON.parse(d); } catch (_) { continue; }
        this.emit('event', evt);
        this._absorbConfigOptions([evt]);
        const p = WorkBuddyLink.turnPiece(evt);
        if (p) pieces.push(p);
      }
    }

    const last = pieces.length ? pieces[pieces.length - 1].req : '';
    const answer = pieces.filter((p) => p.req === last).map((p) => p.text).join('');
    if (answer) {
      this.emit('delta', answer);
      if (onDelta) onDelta(answer);
    }
    this.emit('turnDone', { text: answer });
    return { status: 200, text: answer };
  }

  /**
   * 订阅事件流（GET /api/v1/acp 是独立的 SSE 通道，正文全在这里）。
   * 长连接，不返回；解析出的事件通过 'event' 事件抛出，正文另发 'delta'。
   */
  async startEvents() {
    const r = await fetch(this.base + '/api/v1/acp', { headers: this.headers() });
    if (!r.ok || !r.body) throw new Error('SSE 订阅失败 HTTP ' + r.status);
    this.subscribed = true;
    (async () => {
      const reader = r.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const d = t.slice(5).trim();
            if (!d) continue;
        let evt;
        try { evt = JSON.parse(d); } catch (_) { continue; }
        this.emit('event', evt);
        this._absorbConfigOptions([evt]);
        // ⚠️ 这里**不** emit delta：订阅流会把会话里的历史消息一并推来
            //    （包括 WorkBuddy 自己的回复），当成正文会让界面刷屏。
            //    正文只从 prompt() 的响应流里取。
          }
        }
      } catch (_) {}
      this.subscribed = false;
      this.emit('close');
    })();
    return true;
  }

  /** 从 ACP 的 session/update 里抽正文。正文类型是 agent_message_chunk */
  static extractText(evt) {
    if (!evt || typeof evt !== 'object') return '';
    const p = evt.params || evt;
    const u = p.update;
    if (!u) return '';
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agentMessageChunk') {
      if (u.content && typeof u.content.text === 'string') return u.content.text;
      if (typeof u.text === 'string') return u.text;
    }
    if (kind === 'agent_thought_chunk' && u.content && typeof u.content.text === 'string') {
      return '';   // 思考过程不当作正文
    }
    return '';
  }

  /**
   * 把一条 agent_message_chunk 拆成 { req, text }。
   *
   * req = _meta 里的 conversationRequestId。**同一轮问答的所有片段共享同一个 req**，
   * 不同轮次各不相同 —— 这是把「这次的新回复」从「会话历史重放」里切出来的唯一依据。
   */
  static turnPiece(evt) {
    const u = evt && evt.params && evt.params.update;
    if (!u) return null;
    if (u.sessionUpdate !== 'agent_message_chunk' && u.sessionUpdate !== 'agentMessageChunk') return null;
    const text = (u.content && typeof u.content.text === 'string') ? u.content.text
      : (typeof u.text === 'string' ? u.text : '');
    if (!text) return null;
    const meta = u._meta || {};
    return { req: meta['codebuddy.ai/conversationRequestId'] || '', text };
  }

  /**
   * 从整段 POST 响应体里取出「本次提问」的正文。
   *
   * ⚠️ 这个响应体是**整段会话记录**，不是只有这次的新内容：实测一次 171KB 的响应里，
   * 前 58 个事件都是几小时前的旧轮次，最后才是本次回复。全当正文推给界面的结果就是
   * 「刚问一句，先刷出一大段毫不相干的旧内容」。
   *
   * 做法：只认**最后一个 req**（本次请求的 id，在整段里是最新的那个），同 req 的片段拼起来。
   */
  static extractTurn(sseText) {
    const pieces = [];
    for (const evt of WorkBuddyLink.parseSse(sseText)) {
      const p = WorkBuddyLink.turnPiece(evt);
      if (p) pieces.push(p);
    }
    if (!pieces.length) return '';
    const last = pieces[pieces.length - 1].req;
    return pieces.filter((p) => p.req === last).map((p) => p.text).join('');
  }

  async disconnect() {
    try {
      await fetch(this.base + '/api/v1/acp', { method: 'DELETE', headers: this.headers() });
    } catch (_) {}
    this.ready = false;
  }
}

module.exports = { WorkBuddyLink };
