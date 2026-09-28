#!/usr/bin/env node
/**
 * app/relay-server.js — the peer relay (extensible: supports N agents)
 *
 * 架构：多个 agent 同时连在中继上，**对等**，谁也不指挥谁。
 * 路由全在中继里，agent 之间彼此不知道对方存在。
 *
 *    agent A ← ws  ──┐
 *    agent B ← http ─┼──  Relay  ──  对外只暴露 delta / status / send()
 *    agent C ← ...  ──┘
 *
 * ★ 要接新 agent：改 `agents.js` 加一条即可，本文件不用动。
 *
 * 用法：
 *   const relay = new Relay({ agents, cwd, cwds });
 *   relay.on('delta', ({ from, text }) => ...);
 *   await relay.start();
 *   await relay.send('codex', '...');
 */

'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { CodexLink } = require('./relay');
const { WorkBuddyLink } = require('./workbuddy-link');
const { discoverPorts } = require('./discover');
const i18n = require('./i18n');
const t = i18n.t;

class Relay extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.agents = (o.agents || []).filter((a) => a && a.enabled !== false);
    this.legs = new Map();                 // id → { def, link, cwd, status, base }
    this.logFile = o.logFile || path.join(__dirname, 'relay.jsonl');
    this.cwd = o.cwd || process.cwd();
    this.cwds = o.cwds || {};              // id → 该 agent 的工作空间（每个可不同）
    this.started = false;
    this.markInbound = o.markInbound !== false;
    this._acpBase = null;
  }

  /* ---------- 留档与状态 ---------- */

  _archive(rec) {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, rec)) + '\n', 'utf8');
    } catch (_) {}
  }

  _setStatus(id, s) {
    const leg = this.legs.get(id);
    if (leg) leg.status = s;
    this.emit('status', this.status());
  }

  /** 各 agent 状态快照，如 { codex:'ready', workbuddy:'error' } */
  status() {
    const out = {};
    for (const [id, l] of this.legs) out[id] = l.status;
    return out;
  }

  /* ---------- 起 ---------- */

  async start() {
    const names = this.agents.map((a) => a.name || a.id).join(', ');
    this.emit('info', t('relay.started', { n: this.agents.length, names }));
    for (const def of this.agents) await this.startLeg(def);
    this.started = true;
    return this.status();
  }

  async startLeg(def) {
    const cwd = this.cwds[def.id] || this.cwd;
    const leg = { def, link: null, cwd, status: 'idle', base: null };
    this.legs.set(def.id, leg);
    this._setStatus(def.id, 'connecting');

    try {
      const link = this._makeLink(def);
      link.on('close', () => this._setStatus(def.id, 'closed'));
      link.on('turnDone', () => { this.emit('turnDone', { from: def.id }); this._archive({ from: def.id, kind: 'turnDone' }); });

      if (def.kind === 'codex-app-server') {
        await link.connect();
        await link.init();
        await link.startThread(cwd, { sandbox: 'read-only' });
        this.emit('info', t('relay.readyServer', { name: def.name, thread: link.threadId, cwd }));
      } else if (def.kind === 'acp') {
        const base = def.base || await this._discoverAcp();
        if (!base) throw new Error(t('relay.noAcp'));
        link.base = base;
        leg.base = base;
        await link.connect();
        await link.init();
        await link.startEvents();
        await link.newSession(cwd);
        this.emit('info', t('relay.readyAcp', { name: def.name, base, session: link.sessionId, cwd }));
      } else {
        throw new Error(t('relay.unsupportedKind', { kind: def.kind }));
      }

      leg.link = link;
      this._setStatus(def.id, 'ready');
    } catch (e) {
      this._setStatus(def.id, 'error');
      this.emit('info', t('relay.failed', { name: def.name, msg: e.message }));
    }
    return leg;
  }

  /** 按 kind 造对应的 link 并接好事件 */
  _makeLink(def) {
    const link = def.kind === 'codex-app-server'
      ? new CodexLink(`ws://127.0.0.1:${def.port}`)
      : new WorkBuddyLink(def.base || '');

    link.on('delta', (t) => {
      this.emit('delta', { from: def.id, text: t });
      this._archive({ from: def.id, kind: 'delta', text: t });
    });
    if (typeof link.on === 'function') {
      link.on('reasoning', (t) => this.emit('reasoning', { from: def.id, text: t }));
    }
    return link;
  }

  async _discoverAcp() {
    if (this._acpBase) return this._acpBase;
    const ports = await discoverPorts();
    if (!ports.length) return null;
    this._acpBase = 'http://127.0.0.1:' + ports[0];
    return this._acpBase;
  }

  /* ---------- 发 ---------- */

  async send(agentId, text) {
    const body = String(text || '');
    if (!body) return { ok: false, error: t('relay.emptyText') };
    const leg = this.legs.get(agentId);
    if (!leg) return { ok: false, error: t('relay.unknownAgent', { id: agentId }) };
    if (!leg.link || leg.status !== 'ready') return { ok: false, error: t('relay.notReady', { name: leg.def.name || agentId }) };

    this._archive({ from: 'user', to: agentId, kind: 'prompt', text: body });
    this.emit('sent', { to: agentId, text: body });

    try {
      if (leg.def.kind === 'codex-app-server') {
        await leg.link.say(body);
        return { ok: true };
      }
      // Mark messages injected into an ACP session; otherwise they look exactly
      // like something the user typed themselves.
      const mark = t('relay.mark', { name: leg.def.name || leg.def.id });
      const marked = this.markInbound ? mark + body : body;
      const r = await leg.link.prompt(marked);
      return { ok: true, text: r.text };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ---------- 换工作空间 ---------- */

  async switchWs(agentId, cwd) {
    const leg = this.legs.get(agentId);
    if (!leg) throw new Error(t('relay.unknownAgent', { id: agentId }));
    leg.cwd = cwd;
    this.cwds[agentId] = cwd;
    if (!leg.link || leg.status !== 'ready') {
      this.emit('info', t('relay.notReadyWsOnly', { name: leg.def.name }));
      return null;
    }

    if (leg.def.kind === 'codex-app-server') {
      await leg.link.startThread(cwd, { sandbox: 'read-only' });   // cwd 变了必须新开 thread
      this.emit('info', t('relay.switchedThread', { name: leg.def.name, cwd, thread: leg.link.threadId }));
      return leg.link.threadId;
    }

    if (leg.def.kind === 'acp') {
      // ⚠️ 旧 link 断开时会 emit('close')，而那个回调是「把这个 agent 标成 closed」。
      // 这个 agent 马上要换成新 link，不能被旧连接的善后拖下水 —— 先把它的 close 监听摘掉。
      const old = leg.link;
      if (old) {
        try { old.removeAllListeners('close'); } catch (_) {}
        try { old.disconnect(); } catch (_) {}
      }
      const base = leg.base || await this._discoverAcp();
      const link = this._makeLink(Object.assign({}, leg.def, { base }));
      await link.connect();
      await link.init();
      await link.startEvents();
      await link.newSession(cwd);
      leg.link = link;
      link.on('close', () => this._setStatus(leg.def.id, 'closed'));
      // ⚠️ 切完必须回到 ready。不设的话状态会停在 closed：
      // 界面显示未连接，而且 send() 会因为「未就绪」直接拒发。
      this._setStatus(leg.def.id, 'ready');
      this.emit('info', t('relay.switchedSession', { name: leg.def.name, cwd, session: link.sessionId }));
      return link.sessionId;
    }
    return null;
  }

  close() {
    for (const l of this.legs.values()) {
      try {
        if (!l.link) continue;
        if (typeof l.link.close === 'function') l.link.close();
        else if (typeof l.link.disconnect === 'function') l.link.disconnect();
      } catch (_) {}
    }
    this.started = false;
  }
}

module.exports = { Relay };
