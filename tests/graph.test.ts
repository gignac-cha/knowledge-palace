import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { openDatabase } from '../sources/graph/database.ts';
import { canonicalJSON, nodeHashOf } from '../sources/graph/hash.ts';
import { KnowledgeGraph } from '../sources/graph/knowledge-graph.ts';
import type { DerivationTree } from '../sources/graph/knowledge-graph.ts';
import { loadClaimDirectory } from '../sources/importers/claims.ts';
import { importRFCEntries, parseRFCIndex } from '../sources/importers/rfc-index.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/rfc-index-sample.xml');
const CLAIMS_DIRECTORY = resolve(import.meta.dirname, '../data/claims');

function buildGraph(xml: string = readFileSync(FIXTURE_PATH, 'utf8')): KnowledgeGraph {
  const graph = new KnowledgeGraph(openDatabase(':memory:'));
  importRFCEntries(graph, parseRFCIndex(xml));
  loadClaimDirectory(graph, CLAIMS_DIRECTORY);
  return graph;
}

function idsIn(tree: DerivationTree): string[] {
  return [tree.id, ...tree.dependencies.flatMap(idsIn)];
}

describe('hashing', () => {
  it('serializes objects the same way regardless of key order', () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: 2, c: 3 } }), canonicalJSON({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('changes a node hash when a dependency hash changes', () => {
    const before = nodeHashOf('content', [{ type: 'cites', to: 'rfc9110', nodeHash: 'one' }]);
    const after = nodeHashOf('content', [{ type: 'cites', to: 'rfc9110', nodeHash: 'two' }]);
    assert.notEqual(before, after);
  });
});

describe('RFC index import', () => {
  it('parses entries, numbers, and obsoletes relations', () => {
    const entries = parseRFCIndex(readFileSync(FIXTURE_PATH, 'utf8'));
    const rfc9110 = entries.find((entry) => entry.number === 9110);
    assert.equal(entries.length, 3);
    assert.equal(rfc9110?.title, 'HTTP Semantics');
    assert.ok(rfc9110?.obsoletes.includes(7231));
    assert.deepEqual(rfc9110?.alsoKnownAs, ['STD97']);
  });

  it('records RFC 9110 as superseding RFC 7231 and marks 7231 superseded', () => {
    const graph = buildGraph();
    assert.equal(graph.getNode('rfc7231')?.status, 'superseded');
    assert.deepEqual(
      graph.history('rfc7231').supersededBy.map((step) => step.id),
      ['rfc9110'],
    );
  });

  it('is idempotent: importing the same index twice changes nothing', () => {
    const graph = buildGraph();
    const again = importRFCEntries(graph, parseRFCIndex(readFileSync(FIXTURE_PATH, 'utf8')));
    assert.equal(again.changedDocuments, 0);
    assert.deepEqual(again.staleAfterImport, []);
  });
});

describe('queries', () => {
  it('resolves an alias to the claim before any document', () => {
    const matches = buildGraph().resolve('Referer');
    assert.equal(matches[0]?.id, 'http/referer/request-header');
    assert.equal(matches[0]?.matchedBy, 'alias');
  });

  it('matches several words anywhere in a node, not only as one phrase', () => {
    const ids = buildGraph()
      .resolve('referrer misspelling')
      .map((match) => match.id);
    assert.ok(ids.includes('http/referer/misspelling'));
  });

  it('ranks a document whose title holds the words above one that only mentions them', () => {
    const documents = buildGraph()
      .resolve('HTTP semantics')
      .filter((match) => match.kind === 'document');
    assert.equal(documents[0]?.id, 'rfc9110');
  });

  it('resolves an RFC number', () => {
    assert.equal(buildGraph().resolve('RFC 9110')[0]?.id, 'rfc9110');
  });

  it('derives the spelling inference down to both RFCs it rests on', () => {
    const tree = buildGraph().derive('http/referer/spelling-carried-forward');
    assert.ok(tree !== undefined);
    const ids = idsIn(tree);
    for (const expected of ['http/referer/defined-in-http-1.0', 'http/referer/misspelling', 'rfc1945', 'rfc9110']) {
      assert.ok(ids.includes(expected), `missing ${expected}`);
    }
  });

  it('lists what rests on RFC 1945, including the inference two steps up', () => {
    const impacted = buildGraph().impact('rfc1945');
    assert.deepEqual(
      impacted.map((node) => [node.id, node.depth]),
      [
        ['http/referer/defined-in-http-1.0', 1],
        ['http/referer/spelling-carried-forward', 2],
      ],
    );
  });

  it('follows a claim to the claim that replaced it', () => {
    const history = buildGraph().history('http/methods/idempotent@rfc7231');
    assert.deepEqual(
      history.supersededBy.map((step) => step.id),
      ['http/methods/idempotent'],
    );
  });
});

describe('recompute after a source changes', () => {
  it('marks every reviewed node above a changed RFC as stale, and verify clears it', () => {
    const graph = buildGraph();
    assert.deepEqual(graph.staleNodes(), []);

    // A hypothetical newer RFC obsoletes RFC 9110: its index entry gains an obsoleted-by element.
    const changedXML = readFileSync(FIXTURE_PATH, 'utf8').replace(
      '<doc-id>RFC9110</doc-id>\n    <title>',
      '<doc-id>RFC9110</doc-id>\n    <obsoleted-by><doc-id>RFC99999</doc-id></obsoleted-by>\n    <title>',
    );
    const result = importRFCEntries(graph, parseRFCIndex(changedXML));

    assert.equal(result.changedDocuments, 1);
    assert.equal(graph.getNode('rfc9110')?.status, 'superseded');
    assert.deepEqual(result.staleAfterImport.sort(), [
      'http/methods/idempotent',
      'http/methods/idempotent-retry',
      'http/methods/safe',
      'http/referer/misspelling',
      'http/referer/request-header',
      'http/referer/spelling-carried-forward',
    ]);
    // Claims resting only on RFC 1945 or RFC 7231 are untouched.
    assert.ok(!result.staleAfterImport.includes('http/referer/defined-in-http-1.0'));

    graph.markVerified(result.staleAfterImport);
    assert.deepEqual(graph.staleNodes(), []);
  });
});
