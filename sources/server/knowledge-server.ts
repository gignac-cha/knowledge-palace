import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { KnowledgeGraph, LinkedNode } from '../graph/knowledge-graph.ts';
import type { EdgeType } from '../graph/types.ts';

const INSTRUCTIONS = `Knowledge Palace is a graph of sourced claims. Every claim cites the document it comes from,
and every inference names the claims it is derived from. Use it like this:

1. Call resolve with the words from the question to find node ids (claims rank before documents).
2. Call get_node for the facts, the source section, and the status. Treat status "superseded" as replaced:
   follow get_history to the current node before answering.
3. Call derive to show why a claim holds, down to the cited documents.
4. Call impact to see what would need re-checking if a node changed.

Answer only from nodes the tools return, cite their sourceURL and sourceLocator, and say plainly when no node
covers part of the question instead of filling the gap. If a question's premise conflicts with a node
(for example it calls a request header a response header), correct the premise first.`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function createKnowledgeServer(graph: KnowledgeGraph): McpServer {
  const server = new McpServer({ name: 'knowledge-palace', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'resolve',
    {
      title: 'Find nodes',
      description:
        'Find claims, inferences and documents by id, alias (e.g. "Referer", "RFC 9110", "멱등"), or words in their title or statement.',
      inputSchema: z.object({
        query: z.string().min(1).describe('A name, alias, RFC number, or a few words'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum matches, default 10'),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const matches = graph.resolve(query, limit ?? 10);
      return textResult(
        matches.length === 0
          ? { query, matches, note: 'No node matches. Do not invent an answer; say the graph has no claim for this.' }
          : { query, matches },
      );
    },
  );

  server.registerTool(
    'get_node',
    {
      title: 'Get a node',
      description:
        'A node with its statement, status, source section, and its links: what it cites or is derived from, what supersedes it, and what rests on it.',
      inputSchema: z.object({ id: z.string().min(1).describe('Node id from resolve, e.g. "http/referer/request-header" or "rfc9110"') }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const node = graph.getNode(id);
      if (node === undefined) {
        return notFound(id);
      }
      return textResult({
        id: node.id,
        kind: node.kind,
        title: node.title,
        statement: node.statement,
        status: node.status,
        sourceURL: node.sourceURL,
        sourceLocator: node.sourceLocator,
        scope: node.scope,
        attributes: node.attributes,
        aliases: graph.aliasesOf(node.id),
        reviewState: reviewStateOf(node.verifiedHash, node.nodeHash),
        nodeHash: node.nodeHash,
        links: groupByEdgeType(graph.linkedFrom(node.id), OUTGOING_LABELS),
        backlinks: groupByEdgeType(graph.linkedTo(node.id), INCOMING_LABELS, 25),
      });
    },
  );

  server.registerTool(
    'derive',
    {
      title: 'Derivation chain',
      description:
        'Why a node holds: its premises and cited documents, recursively, as a tree. Use it to explain an answer down to its sources.',
      inputSchema: z.object({
        id: z.string().min(1),
        maxDepth: z.number().int().min(1).max(20).optional().describe('Default 8'),
      }),
      annotations: READ_ONLY,
    },
    async ({ id, maxDepth }) => {
      const tree = graph.derive(id, maxDepth ?? 8);
      return tree === undefined ? notFound(id) : textResult(tree);
    },
  );

  server.registerTool(
    'impact',
    {
      title: 'Impact of a change',
      description:
        'Everything that rests on a node (claims citing a document, inferences built on a claim), breadth first. This is what must be re-checked if the node changes.',
      inputSchema: z.object({
        id: z.string().min(1),
        maxDepth: z.number().int().min(1).max(50).optional().describe('Default 20'),
      }),
      annotations: READ_ONLY,
    },
    async ({ id, maxDepth }) => {
      if (!graph.hasNode(id)) {
        return notFound(id);
      }
      const impacted = graph.impact(id, maxDepth ?? 20);
      const byKind: Record<string, number> = {};
      for (const node of impacted) {
        byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
      }
      return textResult({ id, total: impacted.length, byKind, impacted });
    },
  );

  server.registerTool(
    'get_history',
    {
      title: 'Replacement history',
      description:
        'What replaced a node and what it replaced (supersedes, e.g. RFC 9110 obsoletes RFC 7231), and what amends it (updates).',
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      if (!graph.hasNode(id)) {
        return notFound(id);
      }
      return textResult({ id, ...graph.history(id) });
    },
  );

  server.registerTool(
    'list_stale',
    {
      title: 'Stale nodes',
      description:
        'Reviewed claims and inferences whose cited documents or premises changed since review. Their hash moved, so they need re-checking.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      const stale = graph.staleNodes();
      return textResult({ total: stale.length, stale });
    },
  );

  return server;
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function notFound(id: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: `No node with id "${id}". Call resolve with a name or a few words to find the id.` }],
    isError: true,
  };
}

function reviewStateOf(verifiedHash: string | null, nodeHash: string): 'verified' | 'stale' | 'unreviewed' {
  if (verifiedHash === null) {
    return 'unreviewed';
  }
  return verifiedHash === nodeHash ? 'verified' : 'stale';
}

const OUTGOING_LABELS: Record<EdgeType, string> = {
  cites: 'cites',
  premise: 'premises',
  supersedes: 'supersedes',
  updates: 'updates',
  contests: 'contests',
  synthesizes: 'synthesizes',
  alternative: 'alternatives',
};

const INCOMING_LABELS: Record<EdgeType, string> = {
  cites: 'citedBy',
  premise: 'premiseOf',
  supersedes: 'supersededBy',
  updates: 'updatedBy',
  contests: 'contestedBy',
  synthesizes: 'synthesizedBy',
  alternative: 'alternativeOf',
};

function groupByEdgeType(nodes: readonly LinkedNode[], labels: Record<EdgeType, string>, limitPerType?: number): Record<string, unknown> {
  const groups: Record<string, LinkedNode[]> = {};
  for (const node of nodes) {
    (groups[labels[node.edgeType]] ??= []).push(node);
  }
  return Object.fromEntries(
    Object.entries(groups).map(([edgeType, list]) => {
      const items = list.map(({ edgeType: _edgeType, ...summary }) => summary);
      if (limitPerType === undefined || items.length <= limitPerType) {
        return [edgeType, items];
      }
      return [edgeType, { total: items.length, first: items.slice(0, limitPerType) }];
    }),
  );
}
