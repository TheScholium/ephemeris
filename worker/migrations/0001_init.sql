-- One row per record (task, project, space, settings). `data` is the full JSON
-- including per-field clocks; `seq` is the server change counter used for pulls.
CREATE TABLE IF NOT EXISTS records (
  id     TEXT PRIMARY KEY,
  kind   TEXT NOT NULL,
  data   TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
CREATE INDEX IF NOT EXISTS records_active ON records(active, kind);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0');

-- Precomputed notification times; recomputed whenever a task changes.
CREATE TABLE IF NOT EXISTS alarms (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  url     TEXT NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alarms_due ON alarms(sent, fire_at);
CREATE INDEX IF NOT EXISTS alarms_task ON alarms(task_id);

-- Web Push subscriptions (one per installed device).
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  device   TEXT NOT NULL DEFAULT '',
  created  INTEGER NOT NULL
);
