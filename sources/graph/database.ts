import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DATABASE_PATH = resolve(import.meta.dirname, '../../data/knowledge-palace.sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    statement TEXT,
    status TEXT NOT NULL,
    source_url TEXT,
    source_locator TEXT,
    scope TEXT NOT NULL DEFAULT '{}',
    attributes TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL,
    node_hash TEXT NOT NULL DEFAULT '',
    verified_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, type)
  );
  CREATE INDEX IF NOT EXISTS edges_by_target ON edges (to_id, type);

  CREATE TABLE IF NOT EXISTS aliases (
    alias TEXT NOT NULL,
    node_id TEXT NOT NULL,
    PRIMARY KEY (alias, node_id)
  );
  CREATE INDEX IF NOT EXISTS aliases_by_node ON aliases (node_id);
`;

/** Opens (and creates if needed) the graph database. Pass ':memory:' for a throwaway graph. */
export function openDatabase(path: string = process.env.KNOWLEDGE_PALACE_DATABASE ?? DEFAULT_DATABASE_PATH): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec(SCHEMA);
  return database;
}
