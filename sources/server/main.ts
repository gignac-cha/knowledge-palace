#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { openDatabase } from '../graph/database.ts';
import { KnowledgeGraph } from '../graph/knowledge-graph.ts';
import { createKnowledgeServer } from './knowledge-server.ts';

// stdout is the JSON-RPC channel, so every log line goes to stderr.
const graph = new KnowledgeGraph(openDatabase());
const counts = graph.counts();
if ((counts.document ?? 0) === 0) {
  console.error('knowledge-palace: the graph is empty. Run `pnpm run setup` first.');
}

const handle = serveStdio(() => createKnowledgeServer(graph));
console.error(`knowledge-palace: serving ${JSON.stringify(counts)} on stdio`);

process.on('SIGINT', () => {
  void handle.close();
});
