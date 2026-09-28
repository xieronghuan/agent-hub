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

module.exports = { findSessionFor, DB };
