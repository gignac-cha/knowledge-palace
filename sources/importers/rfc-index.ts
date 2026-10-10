import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import type { KnowledgeGraph } from '../graph/knowledge-graph.ts';

export const RFC_INDEX_URL = 'https://www.rfc-editor.org/rfc-index.xml';
export const DEFAULT_RFC_INDEX_CACHE_PATH = resolve(import.meta.dirname, '../../data/caches/rfc-index.xml');

export interface RFCEntry {
  number: number;
  title: string;
  authors: string[];
  month: string | null;
  year: number | null;
  abstract: string | null;
  keywords: string[];
  alsoKnownAs: string[];
  obsoletes: number[];
  obsoletedBy: number[];
  updates: number[];
  updatedBy: number[];
  currentStatus: string | null;
  stream: string | null;
  doi: string | null;
}

export interface RFCImportResult {
  documents: number;
  changedDocuments: number;
  supersedesEdges: number;
  updatesEdges: number;
  /** Claims and inferences a reviewer had accepted that now rest on a changed document. */
  staleAfterImport: string[];
}

export function documentID(rfcNumber: number): string {
  return `rfc${rfcNumber}`;
}

export function documentURL(rfcNumber: number): string {
  return `https://www.rfc-editor.org/rfc/rfc${rfcNumber}`;
}

/** Downloads the RFC Editor index (about 14 MB) and caches it. */
export async function downloadRFCIndex(cachePath: string = DEFAULT_RFC_INDEX_CACHE_PATH): Promise<string> {
  const response = await fetch(RFC_INDEX_URL);
  if (!response.ok) {
    throw new Error(`Downloading ${RFC_INDEX_URL} failed: HTTP ${response.status}`);
  }
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, await response.text());
  return cachePath;
}

export function readRFCIndex(path: string): RFCEntry[] {
  return parseRFCIndex(readFileSync(path, 'utf8'));
}

const ARRAY_ELEMENTS = new Set(['rfc-entry', 'author', 'kw', 'p', 'doc-id', 'file-format']);

export function parseRFCIndex(xml: string): RFCEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ARRAY_ELEMENTS.has(name),
  });
  const document = parser.parse(xml) as { 'rfc-index'?: { 'rfc-entry'?: RawEntry[] } };
  return (document['rfc-index']?.['rfc-entry'] ?? []).flatMap((raw) => {
    const number = rfcNumberOf(raw['doc-id']?.[0]);
    if (number === undefined) {
      return [];
    }
    const abstract = (raw.abstract?.p ?? [])
      .map((paragraph) => textOf(paragraph))
      .filter((text) => text !== undefined)
      .join('\n\n');
    return [
      {
        number,
        title: textOf(raw.title) ?? `RFC ${number}`,
        authors: (raw.author ?? []).map((author) => textOf(author.name)).filter((name) => name !== undefined),
        month: textOf(raw.date?.month) ?? null,
        year: raw.date?.year === undefined ? null : Number(raw.date.year),
        abstract: abstract === '' ? null : abstract,
        keywords: (raw.keywords?.kw ?? []).map((keyword) => textOf(keyword)).filter((keyword) => keyword !== undefined),
        alsoKnownAs: (raw['is-also']?.['doc-id'] ?? []).map((id) => String(id)),
        obsoletes: rfcNumbersOf(raw.obsoletes),
        obsoletedBy: rfcNumbersOf(raw['obsoleted-by']),
        updates: rfcNumbersOf(raw.updates),
        updatedBy: rfcNumbersOf(raw['updated-by']),
        currentStatus: textOf(raw['current-status']) ?? null,
        stream: textOf(raw.stream) ?? null,
        doi: textOf(raw.doi) ?? null,
      },
    ];
  });
}

/**
 * Loads RFC entries as document nodes with `supersedes` (obsoletes) and `updates` edges.
 * A document's content includes who obsoletes and updates it, so a newer RFC changes its hash
 * and marks every claim citing it as stale.
 */
export function importRFCEntries(graph: KnowledgeGraph, entries: readonly RFCEntry[]): RFCImportResult {
  const known = new Set(entries.map((entry) => entry.number));
  let changedDocuments = 0;
  let supersedesEdges = 0;
  let updatesEdges = 0;

  graph.transaction(() => {
    for (const entry of entries) {
      const id = documentID(entry.number);
      const changed = graph.upsertNode({
        id,
        kind: 'document',
        title: `RFC ${entry.number}: ${entry.title}`,
        ...(entry.abstract === null ? {} : { statement: entry.abstract }),
        status: entry.obsoletedBy.length > 0 ? 'superseded' : 'established',
        sourceURL: documentURL(entry.number),
        attributes: {
          number: entry.number,
          published: [entry.month, entry.year].filter((part) => part !== null).join(' '),
          authors: entry.authors,
          standardStatus: entry.currentStatus,
          stream: entry.stream,
          doi: entry.doi,
          obsoletedBy: entry.obsoletedBy.map(documentID),
          updatedBy: entry.updatedBy.map(documentID),
        },
      });
      if (changed) {
        changedDocuments += 1;
      }
      const obsoletes = entry.obsoletes.filter((number) => known.has(number)).map(documentID);
      const updates = entry.updates.filter((number) => known.has(number)).map(documentID);
      graph.replaceEdges(id, 'supersedes', obsoletes);
      graph.replaceEdges(id, 'updates', updates);
      supersedesEdges += obsoletes.length;
      updatesEdges += updates.length;
      graph.addAliases(id, [`rfc ${entry.number}`, `rfc${entry.number}`, ...entry.alsoKnownAs]);
    }
  });

  graph.recomputeHashes();
  // The index itself is the source for document nodes, so they are accepted as imported.
  graph.transaction(() => graph.markVerified(entries.map((entry) => documentID(entry.number))));

  return {
    documents: entries.length,
    changedDocuments,
    supersedesEdges,
    updatesEdges,
    staleAfterImport: graph.staleNodes().map((node) => node.id),
  };
}

interface RawEntry {
  'doc-id'?: unknown[];
  title?: unknown;
  author?: Array<{ name?: unknown }>;
  date?: { month?: unknown; year?: unknown };
  abstract?: { p?: unknown[] };
  keywords?: { kw?: unknown[] };
  'is-also'?: { 'doc-id'?: unknown[] };
  obsoletes?: { 'doc-id'?: unknown[] };
  'obsoleted-by'?: { 'doc-id'?: unknown[] };
  updates?: { 'doc-id'?: unknown[] };
  'updated-by'?: { 'doc-id'?: unknown[] };
  'current-status'?: unknown;
  stream?: unknown;
  doi?: unknown;
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    return text === undefined ? undefined : String(text);
  }
  return String(value);
}

function rfcNumberOf(docID: unknown): number | undefined {
  const match = /^RFC0*(\d+)$/.exec(String(docID ?? ''));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function rfcNumbersOf(list: { 'doc-id'?: unknown[] } | undefined): number[] {
  return (list?.['doc-id'] ?? []).map(rfcNumberOf).filter((number) => number !== undefined);
}
