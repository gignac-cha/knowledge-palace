#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openDatabase } from './graph/database.ts';
import { KnowledgeGraph } from './graph/knowledge-graph.ts';
import { loadClaimDirectory } from './importers/claims.ts';
import { DEFAULT_RFC_INDEX_CACHE_PATH, downloadRFCIndex, importRFCEntries, readRFCIndex } from './importers/rfc-index.ts';

const USAGE = `Usage: node sources/cli.ts <command>

Commands:
  import-rfc [--file <path>] [--refresh]   Import the RFC Editor index (downloads and caches it unless --file is given)
  load-claims [<directory>]                Load claim files (default: data/claims)
  verify <id>...                           Mark nodes as reviewed after re-checking them
  stale                                    List reviewed nodes whose dependencies changed
  show <id>                                Print a node with its links
  impact <id>                              List what rests on a node
  stats                                    Count nodes and edges`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    refresh: { type: 'boolean', default: false },
  },
});

const [command, ...rest] = positionals;
const graph = new KnowledgeGraph(openDatabase());

switch (command) {
  case 'import-rfc': {
    let path = values.file;
    if (path === undefined) {
      path = DEFAULT_RFC_INDEX_CACHE_PATH;
      if (values.refresh || !existsSync(path)) {
        console.log('Downloading the RFC Editor index...');
        await downloadRFCIndex(path);
      }
    }
    const result = importRFCEntries(graph, readRFCIndex(path));
    console.log(
      `Imported ${result.documents} RFCs (${result.changedDocuments} new or changed), ` +
        `${result.supersedesEdges} obsoletes and ${result.updatesEdges} updates relations.`,
    );
    reportStale(result.staleAfterImport);
    break;
  }
  case 'load-claims': {
    const directory = resolve(rest[0] ?? resolve(import.meta.dirname, '../data/claims'));
    const result = loadClaimDirectory(graph, directory);
    console.log(`Loaded ${result.loaded} claims from ${result.files.length} files (${result.changed.length} new or changed).`);
    for (const missing of result.missingReferences) {
      console.warn(`  missing: ${missing.from} --${missing.edgeType}--> ${missing.to} (import its source first?)`);
    }
    reportStale(result.stale);
    break;
  }
  case 'verify': {
    graph.transaction(() => graph.markVerified(rest));
    console.log(`Marked ${rest.length} node(s) as reviewed.`);
    break;
  }
  case 'stale': {
    const stale = graph.staleNodes();
    console.log(stale.length === 0 ? 'Nothing is stale.' : JSON.stringify(stale, null, 2));
    break;
  }
  case 'show': {
    const id = required(rest[0]);
    console.log(JSON.stringify({ node: graph.getNode(id), links: graph.linkedFrom(id), backlinks: graph.linkedTo(id) }, null, 2));
    break;
  }
  case 'impact': {
    console.log(JSON.stringify(graph.impact(required(rest[0])), null, 2));
    break;
  }
  case 'stats': {
    console.log(JSON.stringify(graph.counts(), null, 2));
    break;
  }
  default: {
    console.log(USAGE);
    process.exitCode = command === undefined ? 0 : 1;
  }
}

function reportStale(ids: readonly string[]): void {
  if (ids.length > 0) {
    console.log(`${ids.length} reviewed node(s) now rest on something that changed and need re-checking:`);
    for (const id of ids) {
      console.log(`  ${id}`);
    }
    console.log('Re-check them, then run: node sources/cli.ts verify <id>...');
  }
}

function required(value: string | undefined): string {
  if (value === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  return value;
}

