/**
 * 状态存储：node:sqlite（Node 24 内置，无外部依赖）。
 *
 * 设计原则：
 * - 六类对象严格分离：Project / Agent / Conversation / Task / Workflow / Execution
 * - 模型与角色解耦：agents.model 与 agents.role_prompt 互不推导
 * - 状态落盘，Gateway 重启不丢
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  dir         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | paused | archived
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  model              TEXT NOT NULL,             -- provider/model，可随时替换
  role_prompt        TEXT NOT NULL DEFAULT '',  -- 角色指令，与模型无关
  workspace          TEXT NOT NULL,
  openclaw_agent_id  TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(agent_id, session_key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id      TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  parent_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'agent_turn', -- agent_turn | executor
  status           TEXT NOT NULL DEFAULT 'pending',
  assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  input            TEXT NOT NULL DEFAULT '',
  output           TEXT NOT NULL DEFAULT '',
  error            TEXT NOT NULL DEFAULT '',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  needs_approval   INTEGER NOT NULL DEFAULT 0,
  executor         TEXT NOT NULL DEFAULT 'agent',
  executor_config  TEXT NOT NULL DEFAULT '{}',
  verify_profile_id TEXT,
  commit_paths     TEXT NOT NULL DEFAULT '[]',
  approved_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'running', -- running | ok | failed | cancelled
  model        TEXT NOT NULL DEFAULT '',
  session_key  TEXT NOT NULL DEFAULT '',
  output       TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  evidence     TEXT NOT NULL DEFAULT '{}',
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',    -- draft | running | paused | done | failed
  spec        TEXT NOT NULL,
  cursor      INTEGER NOT NULL DEFAULT 0,
  rounds      INTEGER NOT NULL DEFAULT 0,
  max_rounds  INTEGER NOT NULL DEFAULT 10,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verify_profiles (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  program     TEXT NOT NULL,
  argv        TEXT NOT NULL DEFAULT '[]',
  cwd         TEXT,
  timeout_ms  INTEGER NOT NULL DEFAULT 300000,
  created_by  TEXT NOT NULL DEFAULT 'operator',
  created_at  TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  digest      TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '{}',
  issued_by   TEXT NOT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id, digest);

CREATE TABLE IF NOT EXISTS execution_resources (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- claude | verify | audit | git_commit | git_ref
  name         TEXT NOT NULL DEFAULT '',  -- 容器名等
  state        TEXT NOT NULL DEFAULT 'started', -- started | running | stopping | stopped | unknown
  started_at   TEXT NOT NULL,
  stopped_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_res_exec ON execution_resources(execution_id);
CREATE INDEX IF NOT EXISTS idx_res_task ON execution_resources(task_id, state);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  digest     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_exec_task ON executions(task_id);
`;

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function migrate(db) {
  // 兼容早期实例：补齐执行器相关列
  if (!hasColumn(db, 'tasks', 'executor')) {
    db.exec("ALTER TABLE tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'agent'");
  }
  if (!hasColumn(db, 'tasks', 'executor_config')) {
    db.exec("ALTER TABLE tasks ADD COLUMN executor_config TEXT NOT NULL DEFAULT '{}'");
  }
  if (!hasColumn(db, 'tasks', 'verify_profile_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN verify_profile_id TEXT');
  }
  if (!hasColumn(db, 'tasks', 'commit_paths')) {
    db.exec("ALTER TABLE tasks ADD COLUMN commit_paths TEXT NOT NULL DEFAULT '[]'");
  }
}

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const now = () => new Date().toISOString();

let counter = 0;
export function newId(prefix) {
  counter = (counter + 1) % 1000;
  const t = Date.now().toString(36);
  const c = counter.toString(36).padStart(2, '0');
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${c}${r}`;
}

export function slugify(input) {
  const s = String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || `p-${Date.now().toString(36)}`;
}
