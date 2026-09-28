'use strict';
/**
 * app/wb-sessions.js — find the WorkBuddy conversation the desktop client is
 * using for a given folder.
 *
 * Why this exists: the ACP `session/new` hands back a session that the desktop
 * client never lists — the client's conversation list comes from
 * `~/.workbuddy/workbuddy.db` (`sessions` table). So anything sent through a
 * `session/new` session is invisible in the WorkBuddy window.
 *
 * Attaching to the id the client already shows instead means the messages land
 * in a conversation the user can actually read and continue.
 *
 * Read-only, and every failure path returns '' so the caller falls back to a
 * normal new session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DB = process.env.WB_DB || path.join(os.homedir(), '.workbuddy', 'workbuddy.db');

/** node:sqlite is experimental but present in Electron's Node */
function open() {
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch (_) { return null; }
  try {
    if (!fs.existsSync(DB)) return null;
    return new sqlite.DatabaseSync(DB, { readOnly: true });
  } catch (_) {
    return null;
  }
}

/** Both sides to forward slashes, case-insensitively comparable */
function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Newest client-visible session id for this folder, or '' when there is none.
 * @param {string} cwd
 */
function findSessionFor(cwd) {
  if (!cwd) return '';
  const db = open();
  if (!db) return '';
  try {
    const rows = db.prepare(
      'select id, cwd, deleted_at from sessions order by updated_at desc limit 300'
    ).all();
    const want = norm(cwd);
    const hit = rows.find((r) => !r.deleted_at && norm(r.cwd) === want);
    return (hit && hit.id) || '';
  } catch (_) {
    return '';
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/** 可写打开（登记会话时用；平时一律只读） */
function openWrite() {
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch (_) { return null; }
  try {
    if (!fs.existsSync(DB)) return null;
    return new sqlite.DatabaseSync(DB);
  } catch (_) { return null; }
}

/** 目标目录要先出现在客户端的「项目」列表里，会话才会挂在它下面 */
function touchWorkspace(db, slashCwd) {
  try {
    db.prepare(
      'insert into workspaces (path, last_opened_at) values (?, ?)'
      + ' on conflict(path) do update set last_opened_at = excluded.last_opened_at'
    ).run(slashCwd, Date.now());
    return true;
  } catch (_) { return false; }
}

/**
 * 把**中继自己起的后端**建出来的会话，登记进客户端的会话列表。
 *
 * 为什么必须登记：客户端显示哪些会话**完全看这张表**。而实测下来，
 * **只有客户端自己起的后端才会写它** —— 中继自己起的后端 `session/new` 之后，
 * 这张表一行都没多（544 → 544）。不登记的话，那个会话在客户端里就看不见。
 *
 * 字段值照客户端自己那条记录（82ee1585…）的格式填，别自己发明。
 *
 * @param {{id:string, cwd:string, title?:string, model?:string}} o
 */
function registerSession(o) {
  const id = o && o.id;
  const cwd = o && o.cwd;
  if (!id || !cwd) return { ok: false, error: '缺 id 或 cwd' };

  const db = openWrite();
  if (!db) return { ok: false, error: '打不开 workbuddy.db' };
  try {
    const u = db.prepare(
      'select user_id from sessions where user_id is not null order by updated_at desc limit 1'
    ).get();
    const userId = (u && u.user_id) || null;
    const slash = String(cwd).replace(/\\/g, '/');
    const now = Date.now();
    touchWorkspace(db, slash);

    db.prepare(
      'insert into sessions (id, cwd, user_id, title, status, created_at, updated_at,'
      + ' is_playground, model, last_activity_at, source_mode, permission_mode,'
      + ' use_sandbox_cli, mode, context_window, thought_level, addon_selection, transport, unread)'
      + ' values (?,?,?,?,?,?,?,0,?,?,?,?,0,?,?,?,?,?,0)'
      + ' on conflict(id) do update set updated_at=excluded.updated_at,'
      + ' last_activity_at=excluded.last_activity_at, cwd=excluded.cwd, title=excluded.title'
    ).run(
      id, slash, userId,
      String(o.title || 'Agent Hub').slice(0, 200),
      'completed', now, now,
      o.model || 'deepseek-v4.1-flash',
      now,
      'working', o.permissionMode || 'fullAccess', o.mode || 'craft',
      1000000, o.thoughtLevel || 'high',
      '{"version":1,"welcomeMode":"working","interactionMode":"craft","permissionMode":"fullAccess"}',
      'local'
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

module.exports = { findSessionFor, registerSession, DB };
