import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as z from 'zod/v4';

import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import { NODE_STATUSES } from '../graph/types.ts';
import type { EdgeType, NodeStatus } from '../graph/types.ts';

const nodeIDSchema = z.string().min(1);

const claimSchema = z.object({
  id: nodeIDSchema,
  kind: z.enum(['claim', 'inference']),
  title: z.string().min(1),
  statement: z.string().min(1),
  status: z.enum(NODE_STATUSES as [NodeStatus, ...NodeStatus[]]),
  sourceURL: z.url().optional(),
  sourceLocator: z.string().optional(),
  scope: z.record(z.string(), z.string()).optional(),
  aliases: z.array(z.string()).default([]),
  cites: z.array(nodeIDSchema).default([]),
  premises: z.array(nodeIDSchema).default([]),
  supersedes: z.array(nodeIDSchema).default([]),
  updates: z.array(nodeIDSchema).default([]),
  contests: z.array(nodeIDSchema).default([]),
  synthesizes: z.array(nodeIDSchema).default([]),
  alternatives: z.array(nodeIDSchema).default([]),
});

const claimFileSchema = z.object({
  description: z.string().optional(),
  nodes: z.array(claimSchema),
});

export type ClaimDefinition = z.infer<typeof claimSchema>;

export interface ClaimLoadResult {
  files: string[];
  loaded: number;
  /** New or edited claims; editing a claim file counts as reviewing it, so these are marked verified. */
  changed: string[];
  /** References to nodes that are not in the graph (for example an RFC not imported yet). */
  missingReferences: Array<{ from: string; to: string; edgeType: EdgeType }>;
  stale: string[];
}

export function readClaimFiles(directory: string): Array<{ file: string; nodes: ClaimDefinition[] }> {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = join(directory, name);
      const parsed = claimFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) {
        throw new Error(`${file} is not a valid claim file:\n${z.prettifyError(parsed.error)}`);
      }
      return { file, nodes: parsed.data.nodes };
    });
}

export function loadClaims(graph: KnowledgeGraph, definitions: readonly ClaimDefinition[]): Omit<ClaimLoadResult, 'files'> {
  const ids = new Set(definitions.map((definition) => definition.id));
  const changed: string[] = [];
  const missingReferences: ClaimLoadResult['missingReferences'] = [];

  graph.transaction(() => {
    for (const definition of definitions) {
      const isNew = !graph.hasNode(definition.id);
      const previousEdges = edgeSignature(graph, definition.id);
      const contentChanged = graph.upsertNode({
        id: definition.id,
        kind: definition.kind,
        title: definition.title,
        statement: definition.statement,
        status: definition.status,
        ...(definition.sourceURL === undefined ? {} : { sourceURL: definition.sourceURL }),
        ...(definition.sourceLocator === undefined ? {} : { sourceLocator: definition.sourceLocator }),
        ...(definition.scope === undefined ? {} : { scope: definition.scope }),
      });
      const edges: Array<[EdgeType, string[]]> = [
        ['cites', definition.cites],
        ['premise', definition.premises],
        ['supersedes', definition.supersedes],
        ['updates', definition.updates],
        ['contests', definition.contests],
        ['synthesizes', definition.synthesizes],
        ['alternative', definition.alternatives],
      ];
      for (const [edgeType, targets] of edges) {
        graph.replaceEdges(definition.id, edgeType, targets);
        for (const target of targets) {
          if (!ids.has(target) && !graph.hasNode(target)) {
            missingReferences.push({ from: definition.id, to: target, edgeType });
          }
        }
      }
      graph.addAliases(definition.id, definition.aliases);
      if (isNew || contentChanged || edgeSignature(graph, definition.id) !== previousEdges) {
        changed.push(definition.id);
      }
    }
  });

  graph.recomputeHashes();
  graph.transaction(() => graph.markVerified(changed));

  return {
    loaded: definitions.length,
    changed,
    missingReferences,
    stale: graph.staleNodes().map((node) => node.id),
  };
}

function edgeSignature(graph: KnowledgeGraph, id: string): string {
  return graph
    .edgesFrom(id)
    .map((edge) => `${edge.type}:${edge.to}`)
    .join('\n');
}

export function loadClaimDirectory(graph: KnowledgeGraph, directory: string): ClaimLoadResult {
  const files = readClaimFiles(directory);
  const result = loadClaims(
    graph,
    files.flatMap((file) => file.nodes),
  );
  return { files: files.map((file) => file.file), ...result };
}
