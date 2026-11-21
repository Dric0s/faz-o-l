// Banco de dados (SQLite embutido no Node, sem dependência nativa).
//
// Canais (um por servidor do Discord), membros, convites, perfis e clipes.
// Fica num volume próprio (/data/app) e sobrevive a atualizações.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = process.env.DB_FILE || '/data/app/fazol.db';
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- "d<id do Discord>" ou "g<hex>" (convidado)
  username    TEXT UNIQUE COLLATE NOCASE, -- @ do Discord (usado nas marcações)
  name        TEXT NOT NULL,
  avatar      TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id                TEXT PRIMARY KEY,
  guild_id          TEXT UNIQUE,         -- servidor do Discord (NULL = canal público do modo convidado)
  name              TEXT NOT NULL,
  icon              TEXT NOT NULL DEFAULT '',
  owner_id          TEXT NOT NULL,       -- quem colocou o bot no servidor
  notify_channel_id TEXT NOT NULL DEFAULT '',
  clips_channel_id  TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'member'
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,                   -- NULL = não expira
  max_uses    INTEGER,                   -- NULL = sem limite
  uses        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clips (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  file          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  duration      REAL NOT NULL DEFAULT 0,
  seconds       INTEGER NOT NULL,
  streamer_id   TEXT NOT NULL,
  streamer_name TEXT NOT NULL,
  creator_id    TEXT NOT NULL,
  creator_name  TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  saved         INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 0, -- já foi postado no Discord
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_channel ON clips(channel_id, created_at);
CREATE INDEX IF NOT EXISTS clips_streamer ON clips(streamer_id);

CREATE TABLE IF NOT EXISTS clip_mentions (
  clip_id  TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  PRIMARY KEY (clip_id, user_id)
);
CREATE INDEX IF NOT EXISTS clip_mentions_user ON clip_mentions(user_id);
`);

// Migrações de colunas novas (ignora se já existir)
for (const stmt of [
  "ALTER TABLE clips ADD COLUMN discord_message TEXT", // "<canal>:<mensagem>" do post no Discord
  "ALTER TABLE clips ADD COLUMN saved_by TEXT", // quem salvou (qualquer membro do canal pode salvar)
]) {
  try {
    db.exec(stmt);
  } catch {}
}

/** Roda fn numa transação (tudo ou nada). */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const cache = new Map();
/** Statement preparado (e reaproveitado). */
export function sql(text) {
  let stmt = cache.get(text);
  if (!stmt) {
    stmt = db.prepare(text);
    cache.set(text, stmt);
  }
  return stmt;
}
