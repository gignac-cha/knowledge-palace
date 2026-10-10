import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

import { openDatabase } from '../sources/graph/database.ts';
import { KnowledgeGraph } from '../sources/graph/knowledge-graph.ts';
import { loadClaimDirectory } from '../sources/importers/claims.ts';
import { importRFCEntries, parseRFCIndex } from '../sources/importers/rfc-index.ts';

const SERVER_PATH = resolve(import.meta.dirname, '../sources/server/main.ts');

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === 'text');
  return first.text;
}

describe('MCP server over stdio', () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledge-palace-'));
  const databasePath = join(directory, 'graph.sqlite');
  const client = new Client({ name: 'knowledge-palace-tests', version: '0.0.0' });

  before(async () => {
    const database = openDatabase(databasePath);
    const graph = new KnowledgeGraph(database);
    importRFCEntries(graph, parseRFCIndex(readFileSync(resolve(import.meta.dirname, 'fixtures/rfc-index-sample.xml'), 'utf8')));
    loadClaimDirectory(graph, resolve(import.meta.dirname, '../data/claims'));
    database.close();

    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_PATH],
        env: { ...getDefaultEnvironment(), KNOWLEDGE_PALACE_DATABASE: databasePath },
        stderr: 'ignore',
      }),
    );
  });

  after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('lists the six read-only tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['derive', 'get_history', 'get_node', 'impact', 'list_stale', 'resolve']);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  });

  it('resolves Referer and returns the request-header claim with its source', async () => {
    const resolved = JSON.parse(textOf(await client.callTool({ name: 'resolve', arguments: { query: 'Referer' } }))) as {
      matches: Array<{ id: string }>;
    };
    assert.equal(resolved.matches[0]?.id, 'http/referer/request-header');

    const node = JSON.parse(textOf(await client.callTool({ name: 'get_node', arguments: { id: 'http/referer/request-header' } }))) as {
      sourceLocator: string;
      reviewState: string;
      links: { cites: Array<{ id: string }> };
    };
    assert.match(node.sourceLocator, /RFC 9110 Section 10\.1/);
    assert.equal(node.reviewState, 'verified');
    assert.deepEqual(
      node.links.cites.map((link) => link.id),
      ['rfc9110'],
    );
  });

  it('reports an unknown id as a tool error instead of inventing a node', async () => {
    const result = await client.callTool({ name: 'get_node', arguments: { id: 'http/referer/response-header' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Call resolve/);
  });

  it('answers impact for RFC 1945', async () => {
    const impact = JSON.parse(textOf(await client.callTool({ name: 'impact', arguments: { id: 'rfc1945' } }))) as {
      total: number;
      byKind: Record<string, number>;
    };
    assert.equal(impact.total, 2);
    assert.deepEqual(impact.byKind, { claim: 1, inference: 1 });
  });
});
