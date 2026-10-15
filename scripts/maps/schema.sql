-- SQLite / App Kit D1 compatible. Query references only; never seller records.
CREATE TABLE IF NOT EXISTS map_datasets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  channel TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS map_views (
  scope TEXT NOT NULL,
  channel TEXT NOT NULL,
  view_json TEXT NOT NULL,
  PRIMARY KEY (scope, channel)
);
-- User-authored personal notes; opaque source IDs only, no seller-row cache.
CREATE TABLE IF NOT EXISTS map_notes (
  scope TEXT NOT NULL,
  channel TEXT NOT NULL,
  location TEXT NOT NULL,
  note TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (scope, channel, location)
);
