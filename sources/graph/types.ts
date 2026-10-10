/** A source document (an RFC), a claim taken from one, or an inference drawn from other claims. */
export type NodeKind = 'document' | 'claim' | 'inference';

export const NODE_KINDS: readonly NodeKind[] = ['document', 'claim', 'inference'];

/**
 * established: checked against its source.
 * scoped: holds only inside the conditions in `scope`.
 * hypothesis: not checked yet.
 * refuted: shown to be false.
 * superseded: replaced by a newer node (see `supersedes` edges).
 */
export type NodeStatus = 'established' | 'scoped' | 'hypothesis' | 'refuted' | 'superseded';

export const NODE_STATUSES: readonly NodeStatus[] = ['established', 'scoped', 'hypothesis', 'refuted', 'superseded'];

/**
 * Edges point from the node that holds them to the node they refer to.
 *
 * Dependency edges feed the target's hash into the holder's hash, so a change below shows up above:
 *   cites:   claim -> the document it was taken from
 *   premise: inference -> a claim or inference it is derived from
 *
 * History and relation edges carry no hash dependency:
 *   supersedes:  newer -> the node it replaces
 *   updates:     newer -> the node it amends without replacing
 *   contests:    a node -> a node it conflicts with
 *   synthesizes: a node -> a branch it merges
 *   alternative: a node -> a competing node
 */
export type EdgeType = 'cites' | 'premise' | 'supersedes' | 'updates' | 'contests' | 'synthesizes' | 'alternative';

export const EDGE_TYPES: readonly EdgeType[] = ['cites', 'premise', 'supersedes', 'updates', 'contests', 'synthesizes', 'alternative'];
export const DEPENDENCY_EDGE_TYPES: readonly EdgeType[] = ['cites', 'premise'];
export const HISTORY_EDGE_TYPES: readonly EdgeType[] = ['supersedes', 'updates'];

export interface NodeInput {
  id: string;
  kind: NodeKind;
  title: string;
  statement?: string;
  status: NodeStatus;
  /** Where the node can be checked, e.g. https://www.rfc-editor.org/rfc/rfc9110#section-10.1.3 */
  sourceURL?: string;
  /** The part of the source that backs the node, e.g. "Section 10.1.3" */
  sourceLocator?: string;
  /** Conditions under which the node holds, e.g. { "protocol": "HTTP/1.0" } */
  scope?: Record<string, string>;
  /** Other facts that belong to the node's content, e.g. an RFC's publication date */
  attributes?: Record<string, unknown>;
}

export interface StoredNode {
  id: string;
  kind: NodeKind;
  title: string;
  statement: string | null;
  status: NodeStatus;
  sourceURL: string | null;
  sourceLocator: string | null;
  scope: Record<string, string>;
  attributes: Record<string, unknown>;
  contentHash: string;
  /** Hash of the content plus the hashes of every dependency, so it changes when anything below changes. */
  nodeHash: string;
  /** The node hash a reviewer last accepted. It differs from nodeHash once something below has changed. */
  verifiedHash: string | null;
}

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface NodeSummary {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  sourceURL: string | null;
}
