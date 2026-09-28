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
const { discoverPorts, portHints } = require('./discover');
const wbSessions = require('./wb-sessions');
const i18n = require('./i18n');
const t = i18n.t;

/**
 * 「谈完了」的暗号：某个 agent 只回这个，就说明这轮不需要再转下去了。
 *
 * 为什么要有这个：agent 之间一旦聊起来，即使没什么可说的也会互相回
 * "收到""待命""无需转发"这类空话 —— 实测不限轮数时 90 秒能空转 25 轮。
 * 靠长度或关键词猜"有没有实质内容"很容易误杀，所以给它们一个**明确的结束方式**。
 */
function isEndToken(s) {
  const bare = String(s || '')
    .replace(/[\s。.!！?？,，、;；:：\[\]【】（）()「」<>《》"'']/g, '')
    .toUpperCase();
  return bare === '完' || bare === 'END' || bare === 'STOP' || bare === 'DONE';
}

class Relay extends EventEmitter {  constructor(opts) {
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
    this._deskTold = {};                   // id → 已经交代过"桌上还有谁"
    // 自动接力：一条腿答完，把它的回复转给其他腿
    this.autoRelay = o.autoRelay !== false; // 开关（config 里的 autoRelay）
    this.maxHops = Number(o.maxHops) || 0;  // 最多转几轮；**0 = 不限**（只能靠 /stop 停）
    this._buf = {};                         // id → 本轮累积的正文
    this._lastText = {};                    // id → 上一轮说了什么（查原地打转）
    this._armed = false;                    // 只有用户"发给所有人"才开启
    this._hop = 0;
    // 借用客户端已有的会话（见 app/wb-sessions.js）
    this.borrowClientSession = o.borrowClientSession !== false;
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

      if (def.kind === 'codex-app-server') {
        await link.connect();
        await link.init();
        await link.startThread(cwd, { sandbox: 'read-only' });
        this.emit('info', t('relay.readyServer', { name: def.name, thread: link.threadId, cwd }));
      } else if (def.kind === 'acp') {
        const base = def.base || await this._discoverAcp(cwd);
        if (!base) throw new Error(t('relay.noAcp'));
        link.base = base;
        leg.base = base;
        await link.connect();
        await link.init();
        await link.startEvents();
        const sid = await this._openSession(link, def, cwd);
        this.emit('info', t('relay.readyAcp', { name: def.name, base, session: sid, cwd }));
        const m = link.currentModel && link.currentModel();
        if (m) {
          leg.model = m.value;
          this.emit('info', t('relay.modelNow', { name: def.name, model: m.label }));
        }
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
      // 累积本轮正文：自动接力要把"这一轮说了什么"整段转给另一条腿
      this._buf[def.id] = (this._buf[def.id] || '') + t;
      this.emit('delta', { from: def.id, text: t });
      this._archive({ from: def.id, kind: 'delta', text: t });
    });
    link.on('turnDone', () => this._onTurnEnd(def.id));
    if (typeof link.on === 'function') {
      link.on('reasoning', (t) => this.emit('reasoning', { from: def.id, text: t }));
    }
    return link;
  }

  /* ---------- 自动接力 ---------- */

  /** 开启（用户发了一条消息）。轮数与"上一轮说了什么"都清零。 */
  arm() { this._armed = true; this._hop = 0; this._lastText = {}; }
  /** 停下（用户发了 /stop，或轮数到顶）。 */
  disarm() { this._armed = false; }
  get armed() { return this._armed; }

  nameOf(id) {
    const a = this.agents.find((x) => x.id === id) || (this.legs.get(id) || {}).def;
    return (a && (a.name || a.id)) || id;
  }

  /** 一条腿答完了：先把正文广播出去，再按需转给其他腿 */
  _onTurnEnd(id) {
    const text = String(this._buf[id] || '').trim();
    this._buf[id] = '';
    this.emit('turnDone', { from: id, text });
    this._archive({ from: id, kind: 'turnDone' });
    if (!this.autoRelay || !this._armed || !text) return;

    // ① 对方明确说"谈完了" → 停
    if (isEndToken(text)) {
      this._armed = false;
      this.emit('info', t('relay.autoEnded', { name: this.nameOf(id) }));
      return;
    }
    // ② 和它上一轮一字不差 → 判在原地打转（实测空转时会出现这类重复）→ 停
    if (text === this._lastText[id]) {
      this._armed = false;
      this.emit('info', t('relay.autoRepeat', { name: this.nameOf(id) }));
      return;
    }
    this._lastText[id] = text;
    this._forward(id, text);
  }

  /** 把 fromId 这轮的回复转给其他腿；maxHops 为 0 表示不限轮数（只能靠 /stop 停） */
  async _forward(fromId, text) {
    for (const a of this.agents) {
      if (a.id === fromId) continue;
      if (this.maxHops > 0 && this._hop >= this.maxHops) {
        this._armed = false;
        this.emit('info', t('relay.autoStopped', { n: this.maxHops }));
        return;
      }
      this._hop++;
      this.emit('info', this.maxHops > 0
        ? t('relay.autoForward', { from: this.nameOf(fromId), to: a.name || a.id, n: this._hop, max: this.maxHops })
        : t('relay.autoForwardNoMax', { from: this.nameOf(fromId), to: a.name || a.id, n: this._hop }));
      // 转发失败要说出来，不能静默吞掉（这里曾被一个 TDZ 错误坑过）
      const res = await this.send(a.id, text, { from: fromId });
      if (res && res.ok === false) {
        this.emit('info', t('relay.autoForwardFailed', { to: a.name || a.id, msg: res.error }));
      }
    }
  }

  /**
   * 为一个目录开 ACP 会话。
   *
   * ⚠️ `session/new` 拿到的会话**不会出现在 WorkBuddy 客户端里**（客户端那份列表读的是
   * `~/.workbuddy/workbuddy.db`），所以从中继发出去的内容在客户端窗口里看不到。
   * 优先**借用客户端已经在这个目录用的那条会话**，借用不成再新建。
   */
  async _openSession(link, def, cwd) {
    const borrow = this.borrowClientSession ? wbSessions.findSessionFor(cwd) : '';
    if (borrow) {
      try {
        await link.loadSession(borrow, cwd);
        this.emit('info', link.loadUnconfirmed
          ? t('relay.borrowUnconfirmed', { name: def.name, session: borrow })
          : t('relay.borrowed', { name: def.name, session: borrow }));
        return link.sessionId;
      } catch (e) {
        this.emit('info', t('relay.borrowFailed', { session: borrow, msg: e.message }));
      }
    }
    return link.newSession(cwd);
  }

  /**
   * 挑一个 ACP 入口。
   *
   * ⚠️ 以前是无脑取端口号最小的那个 —— 但 WorkBuddy 的 ACP 有好几个入口，
   * 其中一个是 CLI host，**它自己的进程就在临时目录里**，agent 在里面干活会找不到用户的文件。
   * 所以按「这个入口的会话记着哪个目录」来挑：
   *   ① 目录正好是我们要的 → 用它
   *   ② 目录是真实目录（不是临时目录） → 用它
   *   ③ 都没有 → 只能退回端口最小的那个，并明确警告
   */
  async _discoverAcp(wantCwd) {
    if (this._acpBase) return this._acpBase;
    const ports = await discoverPorts();
    if (!ports.length) return null;

    const hints = portHints();
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const isTemp = (p) => /[\\/](Temp|tmp|workbuddy-host-cli|__workbuddy_cli_host__)([\\/]|$)/i.test(String(p || ''));
    const want = norm(wantCwd);

    const pick = ports.find((p) => hints[p] && !isTemp(hints[p]) && norm(hints[p]) === want)
      || ports.find((p) => hints[p] && !isTemp(hints[p]))
      || ports[0];

    this._acpBase = 'http://127.0.0.1:' + pick;
    this.emit('info', t('relay.acpPick', { port: pick, cwd: hints[pick] || t('relay.acpUnknownCwd') }));
    if (!hints[pick] || isTemp(hints[pick])) {
      this.emit('info', t('relay.acpTempWarn'));
    }
    return this._acpBase;
  }

  /** 当前各 agent 的模型（ACP 腿才有；Codex 腿留空） */
  modelInfo() {
    const out = {};
    for (const [id, l] of this.legs) {
      if (l.def.kind !== 'acp' || !l.link || !l.link.currentModel) continue;
      const m = l.link.currentModel();
      if (m) out[id] = { value: m.value, label: m.label, choices: l.link.modelChoices() };
    }
    return out;
  }

  /** 改某个 agent 的会话设置（如换模型），成功返回新值 */
  async setConfig(agentId, configId, value) {
    const leg = this.legs.get(agentId);
    if (!leg || !leg.link || !leg.link.setConfigOption) return null;
    const m = await leg.link.setConfigOption(configId, value);
    this.emit('info', t('relay.modelChanged', { name: leg.def.name, model: m.label }));
    return m;
  }

  /* ---------- 发 ---------- */

  async send(agentId, text, opts) {
    const o = opts || {};
    const body = String(text || '');
    if (!body) return { ok: false, error: t('relay.emptyText') };
    const leg = this.legs.get(agentId);
    if (!leg) return { ok: false, error: t('relay.unknownAgent', { id: agentId }) };
    if (!leg.link || leg.status !== 'ready') return { ok: false, error: t('relay.notReady', { name: leg.def.name || agentId }) };

    this._archive({ from: o.from || 'user', to: agentId, kind: 'prompt', text: body });
    this.emit('sent', { to: agentId, text: body, from: o.from || 'user' });

    try {
      // Agents cannot see each other, so without being told they simply guess —
      // asked to "talk to the other one", Codex invented a subagent of its own.
      // Say it once per session, not on every message.
      let head = '';
      if (!this._deskTold[agentId]) {
        const others = this.agents
          .filter((a) => a.id !== agentId)
          .map((a) => a.name || a.id);
        this._deskTold[agentId] = true;
        if (others.length) head = t('relay.desk', { others: others.join(' / '), end: t('relay.endToken') }) + '\n';
      }

      // 自动转来的消息必须写清是谁说的，否则对方只看到一段裸回复，
      // 不知道是桌上另一个 agent 在跟自己说话。
      const mark = o.from
        ? t('relay.fromAgent', { name: this.nameOf(o.from) })
        : t('relay.mark', { name: leg.def.name || leg.def.id });

      if (leg.def.kind === 'codex-app-server') {
        const prefix = o.from ? mark : '';
        await leg.link.say(head + prefix + body);
        return { ok: true };
      }
      // ACP：注入的正文和用户自己打的字长得一模一样，必须加标记才分得出来
      const marked = this.markInbound ? mark + body : body;
      const r = await leg.link.prompt(head + marked);
      return { ok: true, text: r.text };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ---------- 换工作空间 ---------- */

  async switchWs(agentId, cwd) {
    const leg = this.legs.get(agentId);
    if (!leg) throw new Error(t('relay.unknownAgent', { id: agentId }));
    // A new session/thread forgets who else is on the desk, so announce it again
    delete this._deskTold[agentId];
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
      const base = leg.base || await this._discoverAcp(cwd);
      const link = this._makeLink(Object.assign({}, leg.def, { base }));
      await link.connect();
      await link.init();
      await link.startEvents();
      const sid = await this._openSession(link, leg.def, cwd);
      leg.link = link;
      link.on('close', () => this._setStatus(leg.def.id, 'closed'));
      // ⚠️ 切完必须回到 ready。不设的话状态会停在 closed：
      // 界面显示未连接，而且 send() 会因为「未就绪」直接拒发。
      this._setStatus(leg.def.id, 'ready');
      this.emit('info', t('relay.switchedSession', { name: leg.def.name, cwd, session: sid }));
      return sid;
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
