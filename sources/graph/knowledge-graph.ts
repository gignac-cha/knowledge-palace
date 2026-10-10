import type { DatabaseSync } from 'node:sqlite';

import { contentHashOf, nodeHashOf } from './hash.ts';
import type { DependencyHash } from './hash.ts';
import { DEPENDENCY_EDGE_TYPES } from './types.ts';
import type { Edge, EdgeType, NodeInput, NodeKind, NodeStatus, NodeSummary, StoredNode } from './types.ts';

interface NodeRow {
  id: string;
  kind: string;
  title: string;
  statement: string | null;
  status: string;
  source_url: string | null;
  source_locator: string | null;
  scope: string;
  attributes: string;
  content_hash: string;
  node_hash: string;
  verified_hash: string | null;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  type: string;
}

export interface LinkedNode extends NodeSummary {
  edgeType: EdgeType;
}

export interface DerivationTree extends NodeSummary {
  statement: string | null;
  sourceLocator: string | null;
  /** How this node is reached from its parent in the tree; absent on the root. */
  edgeType?: EdgeType;
  dependencies: DerivationTree[];
  /** True when the node was already expanded elsewhere in the tree, or the depth limit was reached. */
  truncated?: boolean;
}

export interface ImpactedNode extends NodeSummary {
  depth: number;
  /** The node one step closer to the changed node. */
  through: string;
  edgeType: EdgeType;
}

export interface HistoryStep extends NodeSummary {
  depth: number;
  edgeType: EdgeType;
}

export interface NodeHistory {
  /** Newer nodes that replace this one, nearest first. */
  supersededBy: HistoryStep[];
  /** Older nodes this one replaces, nearest first. */
  supersedes: HistoryStep[];
  /** Newer nodes that amend this one. */
  updatedBy: HistoryStep[];
  /** Older nodes this one amends. */
  updates: HistoryStep[];
}

export interface ResolveMatch extends NodeSummary {
  matchedBy: 'id' | 'alias' | 'text';
}

const DEPENDENCY_PLACEHOLDERS = DEPENDENCY_EDGE_TYPES.map(() => '?').join(', ');

export function normalizeAlias(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The claim graph: nodes, typed edges, aliases, and Merkle-style hashes that make the effect of a change visible.
 */
export class KnowledgeGraph {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  transaction<Result>(work: () => Result): Result {
    this.database.exec('BEGIN');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Inserts or updates a node. Returns true when its content is new or changed. */
  upsertNode(input: NodeInput): boolean {
    const contentHash = contentHashOf(input);
    const existing = this.database.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(input.id) as
      | { content_hash: string }
      | undefined;
    if (existing?.content_hash === contentHash) {
      return false;
    }
    this.database
      .prepare(
        `INSERT INTO nodes (id, kind, title, statement, status, source_url, source_locator, scope, attributes, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title, statement = excluded.statement, status = excluded.status,
           source_url = excluded.source_url, source_locator = excluded.source_locator, scope = excluded.scope,
           attributes = excluded.attributes, content_hash = excluded.content_hash`,
      )
      .run(
        input.id,
        input.kind,
        input.title,
        input.statement ?? null,
        input.status,
        input.sourceURL ?? null,
        input.sourceLocator ?? null,
        JSON.stringify(input.scope ?? {}),
        JSON.stringify(input.attributes ?? {}),
        contentHash,
      );
    return true;
  }

  /** Replaces every outgoing edge of `type` from `from` with edges to `targets`. */
  replaceEdges(from: string, type: EdgeType, targets: readonly string[]): void {
    this.database.prepare('DELETE FROM edges WHERE from_id = ? AND type = ?').run(from, type);
    const insert = this.database.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, ?)');
    for (const target of targets) {
      insert.run(from, target, type);
    }
  }

  addAliases(nodeID: string, aliases: readonly string[]): void {
    const insert = this.database.prepare('INSERT OR IGNORE INTO aliases (alias, node_id) VALUES (?, ?)');
    for (const alias of aliases) {
      insert.run(normalizeAlias(alias), nodeID);
    }
  }

  hasNode(id: string): boolean {
    return this.database.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id) !== undefined;
  }

  getNode(id: string): StoredNode | undefined {
    const row = this.database.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row === undefined ? undefined : toStoredNode(row);
  }

  summary(id: string): NodeSummary | undefined {
    const node = this.getNode(id);
    return node === undefined ? undefined : toSummary(node);
  }

  aliasesOf(id: string): string[] {
    const rows = this.database.prepare('SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias').all(id) as Array<{
      alias: string;
    }>;
    return rows.map((row) => row.alias);
  }

  edgesFrom(id: string): Edge[] {
    const rows = this.database.prepare('SELECT * FROM edges WHERE from_id = ? ORDER BY type, to_id').all(id) as unknown as EdgeRow[];
    return rows.map(toEdge);
  }

  edgesTo(id: string): Edge[] {
    const rows = this.database.prepare('SELECT * FROM edges WHERE to_id = ? ORDER BY type, from_id').all(id) as unknown as EdgeRow[];
    return rows.map(toEdge);
  }

  /** Outgoing edges with the node at the other end, skipping edges whose target is not in the graph. */
  linkedFrom(id: string): LinkedNode[] {
    return this.edgesFrom(id).flatMap((edge) => {
      const target = this.summary(edge.to);
      return target === undefined ? [] : [{ ...target, edgeType: edge.type }];
    });
  }

  /** Incoming edges with the node at the other end. */
  linkedTo(id: string): LinkedNode[] {
    return this.edgesTo(id).flatMap((edge) => {
      const source = this.summary(edge.from);
      return source === undefined ? [] : [{ ...source, edgeType: edge.type }];
    });
  }

  /** Finds nodes by id, alias, or words in their title or statement. Claims and inferences rank before documents. */
  resolve(query: string, limit = 10): ResolveMatch[] {
    const normalized = normalizeAlias(query);
    const matches = new Map<string, ResolveMatch>();
    const add = (id: string, matchedBy: ResolveMatch['matchedBy']): void => {
      if (matches.has(id)) {
        return;
      }
      const summary = this.summary(id);
      if (summary !== undefined) {
        matches.set(id, { ...summary, matchedBy });
      }
    };

    if (this.hasNode(query.trim())) {
      add(query.trim(), 'id');
    }
    const aliasRows = this.database
      .prepare(
        `SELECT aliases.node_id AS id FROM aliases JOIN nodes ON nodes.id = aliases.node_id
         WHERE aliases.alias = ? ORDER BY CASE nodes.kind WHEN 'document' THEN 1 ELSE 0 END, nodes.id`,
      )
      .all(normalized) as Array<{ id: string }>;
    for (const row of aliasRows) {
      add(row.id, 'alias');
    }
    // Every word must appear somewhere in the title, the statement, or an alias.
    const words = normalized.split(' ').filter((word) => word.length > 0);
    if (words.length > 0) {
      const condition = `(lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(statement, '')) LIKE ? ESCAPE '\\'
        OR id IN (SELECT node_id FROM aliases WHERE alias LIKE ? ESCAPE '\\'))`;
      const patterns = words.map((word) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
      // Rank: claims before documents, current before superseded, more words in the title, shorter titles.
      const titleHits = patterns.map(() => `(lower(title) LIKE ? ESCAPE '\\')`).join(' + ');
      const textRows = this.database
        .prepare(
          `SELECT id FROM nodes WHERE ${words.map(() => condition).join(' AND ')}
           ORDER BY CASE kind WHEN 'document' THEN 1 ELSE 0 END, CASE status WHEN 'superseded' THEN 1 ELSE 0 END,
             ${titleHits} DESC, length(title), id
           LIMIT ?`,
        )
        .all(...patterns.flatMap((pattern) => [pattern, pattern, pattern]), ...patterns, limit) as Array<{ id: string }>;
      for (const row of textRows) {
        add(row.id, 'text');
      }
    }
    return [...matches.values()].slice(0, limit);
  }

  /** What a node rests on: its cited documents and premises, recursively, down to the roots. */
  derive(id: string, maxDepth = 8): DerivationTree | undefined {
    const expanded = new Set<string>();
    const build = (nodeID: string, depth: number, edgeType?: EdgeType): DerivationTree | undefined => {
      const node = this.getNode(nodeID);
      if (node === undefined) {
        return undefined;
      }
      const tree: DerivationTree = {
        ...toSummary(node),
        statement: node.statement,
        sourceLocator: node.sourceLocator,
        ...(edgeType === undefined ? {} : { edgeType }),
        dependencies: [],
      };
      if (expanded.has(nodeID) || depth >= maxDepth) {
        if (this.dependencyEdgesFrom(nodeID).length > 0) {
          tree.truncated = true;
        }
        return tree;
      }
      expanded.add(nodeID);
      for (const edge of this.dependencyEdgesFrom(nodeID)) {
        const child = build(edge.to, depth + 1, edge.type);
        if (child !== undefined) {
          tree.dependencies.push(child);
        }
      }
      return tree;
    };
    return build(id, 0);
  }

  /** Everything that rests on a node, breadth first: what would need re-checking if it changed. */
  impact(id: string, maxDepth = 20): ImpactedNode[] {
    const visited = new Set<string>([id]);
    const impacted: ImpactedNode[] = [];
    let frontier = [id];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const nodeID of frontier) {
        for (const edge of this.dependencyEdgesTo(nodeID)) {
          if (visited.has(edge.from)) {
            continue;
          }
          visited.add(edge.from);
          const summary = this.summary(edge.from);
          if (summary !== undefined) {
            impacted.push({ ...summary, depth, through: nodeID, edgeType: edge.type });
            next.push(edge.from);
          }
        }
      }
      frontier = next;
    }
    return impacted;
  }

  /** Replacement and amendment chains in both directions. */
  history(id: string, maxDepth = 30): NodeHistory {
    return {
      supersededBy: this.walk(id, 'supersedes', 'incoming', maxDepth),
      supersedes: this.walk(id, 'supersedes', 'outgoing', maxDepth),
      updatedBy: this.walk(id, 'updates', 'incoming', maxDepth),
      updates: this.walk(id, 'updates', 'outgoing', maxDepth),
    };
  }

  /**
   * Recomputes every node hash from its content and its dependencies' hashes.
   * Returns the ids whose hash changed.
   */
  recomputeHashes(): string[] {
    const rows = this.database.prepare('SELECT id, content_hash, node_hash FROM nodes').all() as Array<{
      id: string;
      content_hash: string;
      node_hash: string;
    }>;
    const contentHashes = new Map(rows.map((row) => [row.id, row.content_hash]));
    const previous = new Map(rows.map((row) => [row.id, row.node_hash]));
    const dependencies = new Map<string, Array<{ to: string; type: string }>>();
    const edgeRows = this.database
      .prepare(`SELECT from_id, to_id, type FROM edges WHERE type IN (${DEPENDENCY_PLACEHOLDERS})`)
      .all(...DEPENDENCY_EDGE_TYPES) as unknown as EdgeRow[];
    for (const edge of edgeRows) {
      if (!contentHashes.has(edge.to_id)) {
        continue;
      }
      const list = dependencies.get(edge.from_id) ?? [];
      list.push({ to: edge.to_id, type: edge.type });
      dependencies.set(edge.from_id, list);
    }

    const computed = new Map<string, string>();
    const inProgress = new Set<string>();
    const compute = (id: string): string => {
      const done = computed.get(id);
      if (done !== undefined) {
        return done;
      }
      if (inProgress.has(id)) {
        throw new Error(`Dependency cycle through ${id}: premises and citations must not loop.`);
      }
      inProgress.add(id);
      const dependencyHashes: DependencyHash[] = (dependencies.get(id) ?? []).map((dependency) => ({
        type: dependency.type,
        to: dependency.to,
        nodeHash: compute(dependency.to),
      }));
      const hash = nodeHashOf(contentHashes.get(id) ?? '', dependencyHashes);
      inProgress.delete(id);
      computed.set(id, hash);
      return hash;
    };

    const changed: string[] = [];
    const update = this.database.prepare('UPDATE nodes SET node_hash = ? WHERE id = ?');
    this.transaction(() => {
      for (const id of contentHashes.keys()) {
        const hash = compute(id);
        if (previous.get(id) !== hash) {
          update.run(hash, id);
          changed.push(id);
        }
      }
    });
    return changed;
  }

  /** Records that a reviewer accepted the node as it stands now. */
  markVerified(ids: readonly string[]): void {
    const update = this.database.prepare('UPDATE nodes SET verified_hash = node_hash WHERE id = ?');
    for (const id of ids) {
      update.run(id);
    }
  }

  /** Nodes a reviewer accepted earlier whose hash has changed since: something they rest on moved. */
  staleNodes(): Array<NodeSummary & { changedDependencies: string[] }> {
    const rows = this.database
      .prepare('SELECT * FROM nodes WHERE verified_hash IS NOT NULL AND verified_hash != node_hash ORDER BY kind, id')
      .all() as unknown as NodeRow[];
    return rows.map((row) => {
      const node = toStoredNode(row);
      return { ...toSummary(node), changedDependencies: this.dependencyEdgesFrom(node.id).map((edge) => edge.to) };
    });
  }

  counts(): Record<string, number> {
    const rows = this.database.prepare('SELECT kind, count(*) AS total FROM nodes GROUP BY kind').all() as Array<{
      kind: string;
      total: number;
    }>;
    const edges = this.database.prepare('SELECT count(*) AS total FROM edges').get() as { total: number };
    return { ...Object.fromEntries(rows.map((row) => [row.kind, row.total])), edges: edges.total };
  }

  private dependencyEdgesFrom(id: string): Edge[] {
    const rows = this.database
      .prepare(`SELECT * FROM edges WHERE from_id = ? AND type IN (${DEPENDENCY_PLACEHOLDERS}) ORDER BY type, to_id`)
      .all(id, ...DEPENDENCY_EDGE_TYPES) as unknown as EdgeRow[];
    return rows.map(toEdge);
  }

  private dependencyEdgesTo(id: string): Edge[] {
    const rows = this.database
      .prepare(`SELECT * FROM edges WHERE to_id = ? AND type IN (${DEPENDENCY_PLACEHOLDERS}) ORDER BY type, from_id`)
      .all(id, ...DEPENDENCY_EDGE_TYPES) as unknown as EdgeRow[];
    return rows.map(toEdge);
  }

  private walk(id: string, type: EdgeType, direction: 'incoming' | 'outgoing', maxDepth: number): HistoryStep[] {
    const visited = new Set<string>([id]);
    const steps: HistoryStep[] = [];
    let frontier = [id];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const nodeID of frontier) {
        const edges = direction === 'incoming' ? this.edgesTo(nodeID) : this.edgesFrom(nodeID);
        for (const edge of edges) {
          const other = direction === 'incoming' ? edge.from : edge.to;
          if (edge.type !== type || visited.has(other)) {
            continue;
          }
          visited.add(other);
          const summary = this.summary(other);
          if (summary !== undefined) {
            steps.push({ ...summary, depth, edgeType: type });
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return steps;
  }
}

function toStoredNode(row: NodeRow): StoredNode {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    title: row.title,
    statement: row.statement,
    status: row.status as NodeStatus,
    sourceURL: row.source_url,
    sourceLocator: row.source_locator,
    scope: JSON.parse(row.scope) as Record<string, string>,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    contentHash: row.content_hash,
    nodeHash: row.node_hash,
    verifiedHash: row.verified_hash,
  };
}

function toSummary(node: StoredNode): NodeSummary {
  return { id: node.id, kind: node.kind, title: node.title, status: node.status, sourceURL: node.sourceURL };
}

function toEdge(row: EdgeRow): Edge {
  return { from: row.from_id, to: row.to_id, type: row.type as EdgeType };
}
