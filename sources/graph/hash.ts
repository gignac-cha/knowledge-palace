import { createHash } from 'node:crypto';

import type { NodeInput } from './types.ts';

/** JSON with object keys sorted at every level, so equal content always serializes to the same string. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJSON(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJSON(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of what the node itself says, independent of the nodes it depends on. */
export function contentHashOf(node: NodeInput): string {
  return sha256(
    canonicalJSON({
      kind: node.kind,
      title: node.title,
      statement: node.statement ?? null,
      status: node.status,
      sourceURL: node.sourceURL ?? null,
      sourceLocator: node.sourceLocator ?? null,
      scope: node.scope ?? {},
      attributes: node.attributes ?? {},
    }),
  );
}

export interface DependencyHash {
  type: string;
  to: string;
  nodeHash: string;
}

/**
 * Merkle-style node hash: the node's own content hash plus the node hashes of its dependencies.
 * When a premise or cited document changes, every node above it gets a new hash.
 */
export function nodeHashOf(contentHash: string, dependencies: readonly DependencyHash[]): string {
  const lines = dependencies
    .map((dependency) => `${dependency.type}:${dependency.to}:${dependency.nodeHash}`)
    .sort();
  return sha256([contentHash, ...lines].join('\n'));
}
