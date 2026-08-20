/**
 * SECOND LAYER — the tree of ways to establish a claim.
 *
 * The graph has always recorded *claims* (what is true) but never *how we
 * intend to establish one*. Collapsing the two is expensive: a refuted
 * ATTEMPT reads as a refuted IDEA, and a hypothesis dies while a perfectly
 * good next approach is already written down.
 *
 * The convention this module supports (no schema change, only topology):
 *
 *   Layer 1 — CLAIM     trigger `prediction` (or `question`), title "H10 · …".
 *                       Status is topology: an `invalidates` edge → refuted,
 *                       `validates` → confirmed, incoming `supersedes` →
 *                       re-specified, NO adjudicating edge at all → OPEN.
 *
 *   Layer 2 — APPROACH  trigger `experiment`, title "H10/2 · …".
 *                       `implements` edge to its claim — the load-bearing
 *                       link: "this node is a way to test that", not a fact
 *                       about the market. `learned_from` to a parent approach
 *                       when it is born of that approach's failure,
 *                       `refines` when it narrows one.
 *
 * Everything here is read-only and degrades to an empty result on a graph
 * that has no second layer yet — which is every graph written before this.
 */

import {
  getGraphStore,
  isProjectLoaded,
  queryEdges,
  queryNodes,
} from '@emergent-wisdom/understanding-graph-core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ContextManager } from '../context-manager.js';
import {
  findIdCollisions,
  formatStableId,
  nextFreeApproachNum,
  nextFreeClaimNum,
  parseStableId,
  scanStableIds,
} from './stable-ids.js';

/** Edges that pass judgement on a node, in either direction. */
export const ADJUDICATING_EDGE_TYPES = ['validates', 'invalidates'] as const;

/** Edge that turns an approach into a child of another approach. */
const APPROACH_PARENT_EDGE_TYPES = ['learned_from', 'refines'] as const;

/** The trigger the convention reserves for layer 2. */
export const APPROACH_TRIGGER = 'experiment';

/** Triggers the convention uses for layer 1. */
export const CLAIM_TRIGGERS = ['prediction', 'question'] as const;

export type NodeStatus =
  | 'open'
  | 'confirmed'
  | 'refuted'
  | 'answered'
  | 'superseded';

export interface GraphIndexNode {
  id: string;
  title: string;
  trigger: string | null;
  understanding: string | null;
  createdAt: string;
}

interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  why: string | null;
}

export interface GraphIndex {
  nodes: Map<string, GraphIndexNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
}

/** Generous ceilings: this corpus is ~1.5k nodes / ~4k edges, one query each. */
const NODE_SCAN_LIMIT = 100_000;
const EDGE_SCAN_LIMIT = 500_000;

/**
 * One node query and one edge query, indexed in memory. Cheaper and far more
 * predictable than the per-node `queryEdges` calls the older tools do, and it
 * behaves identically on SQLite and on Postgres because both go through the
 * same `db.prepare(...).all()` facade.
 */
export function loadGraphIndex(
  projectId: string,
  includeArchived = false,
): GraphIndex {
  const nodes = new Map<string, GraphIndexNode>();
  for (const n of queryNodes(projectId, {
    limit: NODE_SCAN_LIMIT,
    includeArchived,
  })) {
    nodes.set(n.id, {
      id: n.id,
      title: n.title,
      trigger: n.trigger,
      understanding: n.understanding,
      createdAt: n.createdAt,
    });
  }

  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of queryEdges(projectId, { limit: EDGE_SCAN_LIMIT })) {
    const o = out.get(e.fromId);
    if (o) o.push(e);
    else out.set(e.fromId, [e]);
    const i = inc.get(e.toId);
    if (i) i.push(e);
    else inc.set(e.toId, [e]);
  }

  return { nodes, out, in: inc };
}

export interface Resolution {
  status: NodeStatus;
  /** The edge that closed it, with the reason its author gave. */
  closedBy?: {
    edgeType: string;
    direction: 'incoming' | 'outgoing';
    otherId: string;
    otherName: string;
    why: string | null;
  };
}

/**
 * Status from topology alone, for ANY trigger. This is the whole point of the
 * fix: the old `unresolvedOnly` knew only `prediction` and `question` and
 * silently returned everything for every other trigger.
 *
 *   - an `invalidates` edge touching the node (either direction) → refuted
 *   - a `validates` edge touching the node (either direction)    → confirmed
 *   - an incoming `answers` edge (questions only)                → answered
 *   - an incoming `supersedes` edge                              → superseded
 *   - nothing of the above                                       → OPEN
 *
 * Both directions count for validates/invalidates because both are used in
 * practice: a result node points `invalidates` AT a claim, while an approach
 * that produced a verdict points `invalidates` at what it refuted. Either way
 * the node in question has been adjudicated.
 */
export function deriveStatus(
  nodeId: string,
  index: GraphIndex,
  trigger?: string | null,
): Resolution {
  const outgoing = index.out.get(nodeId) || [];
  const incoming = index.in.get(nodeId) || [];
  const t = trigger ?? index.nodes.get(nodeId)?.trigger ?? null;

  const describe = (
    e: GraphEdge,
    direction: 'incoming' | 'outgoing',
  ): Resolution['closedBy'] => {
    const otherId = direction === 'incoming' ? e.fromId : e.toId;
    return {
      edgeType: e.type,
      direction,
      otherId,
      otherName: index.nodes.get(otherId)?.title ?? 'unknown',
      why: e.why,
    };
  };

  // Refutation wins over confirmation: a node carrying both has been argued
  // about, and the negative verdict is the one a reader must not miss.
  for (const type of ['invalidates', 'validates'] as const) {
    const hitIn = incoming.find((e) => e.type === type);
    if (hitIn) {
      return {
        status: type === 'invalidates' ? 'refuted' : 'confirmed',
        closedBy: describe(hitIn, 'incoming'),
      };
    }
    const hitOut = outgoing.find((e) => e.type === type);
    if (hitOut) {
      return {
        status: type === 'invalidates' ? 'refuted' : 'confirmed',
        closedBy: describe(hitOut, 'outgoing'),
      };
    }
  }

  if (t === 'question') {
    const answered = incoming.find((e) => e.type === 'answers');
    if (answered) {
      return { status: 'answered', closedBy: describe(answered, 'incoming') };
    }
  }

  const superseded = incoming.find((e) => e.type === 'supersedes');
  if (superseded) {
    return { status: 'superseded', closedBy: describe(superseded, 'incoming') };
  }

  return { status: 'open' };
}

export function isOpen(
  nodeId: string,
  index: GraphIndex,
  trigger?: string | null,
): boolean {
  return deriveStatus(nodeId, index, trigger).status === 'open';
}

/**
 * Which claim does this approach ultimately serve?
 *
 * Only the FIRST approach in a chain carries `implements`; a child approach
 * born of its parent's failure hangs off the parent by `learned_from` /
 * `refines`. Walking up that chain is what stops a depth-2 approach from
 * being reported as belonging to no claim — which would be exactly the
 * orphaning this whole layer exists to prevent.
 */
export function claimOfApproach(
  approachId: string,
  index: GraphIndex,
  maxHops = 8,
): {
  id: string;
  name: string;
  hops: number;
  /** Every claim this approach declares itself a way of testing, when >1. */
  alsoImplements?: Array<{ id: string; name: string }>;
} | null {
  let current = approachId;
  const seen = new Set<string>([approachId]);

  for (let hop = 0; hop < maxHops; hop++) {
    const outgoing = index.out.get(current) || [];
    const impls = outgoing.filter((e) => e.type === 'implements');
    const impl = impls[0];
    if (impl) {
      // More than one `implements` edge is not a richer attribution, it is an
      // unresolved one — and it happens exactly when two claims share a stable
      // id and the writer wired its approach to both. Reporting only the first
      // (which is what every caller used to get) hides half the topology.
      return {
        id: impl.toId,
        name: index.nodes.get(impl.toId)?.title ?? 'unknown',
        hops: hop,
        alsoImplements:
          impls.length > 1
            ? impls.slice(1).map((e) => ({
                id: e.toId,
                name: index.nodes.get(e.toId)?.title ?? 'unknown',
              }))
            : undefined,
      };
    }
    const up = outgoing.find(
      (e) =>
        (APPROACH_PARENT_EDGE_TYPES as readonly string[]).includes(e.type) &&
        index.nodes.get(e.toId)?.trigger === APPROACH_TRIGGER &&
        !seen.has(e.toId),
    );
    if (!up) return null;
    seen.add(up.toId);
    current = up.toId;
  }
  return null;
}

export interface ApproachEntry {
  id: string;
  name: string;
  trigger: string | null;
  depth: number;
  parentId: string;
  /** `implements` at depth 1; `learned_from` / `refines` deeper. */
  via: string;
  /** The `why` of the edge that attaches it to its parent. */
  linkWhy: string | null;
  status: NodeStatus;
  closedBy?: Resolution['closedBy'];
  /** Convention check: layer-2 nodes are supposed to carry trigger experiment. */
  isApproach: boolean;
}

/**
 * The approach subtree under one claim.
 *
 * Depth 1 = every node with an `implements` edge INTO the claim.
 * Deeper   = every node with `learned_from` / `refines` INTO an approach.
 *
 * Only nodes that are themselves approaches (trigger `experiment`) are
 * expanded further; a `surprise` or `analysis` node that happens to refine an
 * approach is reported at its level but is not treated as a branch of the
 * search tree, and never counts toward the open/closed tally.
 */
export function collectApproaches(
  claimId: string,
  index: GraphIndex,
  maxDepth = 5,
): ApproachEntry[] {
  const out: ApproachEntry[] = [];
  const visited = new Set<string>([claimId]);

  let frontier: Array<{ id: string; depth: number }> = [
    { id: claimId, depth: 0 },
  ];

  while (frontier.length > 0) {
    const next: Array<{ id: string; depth: number }> = [];
    for (const { id, depth } of frontier) {
      if (depth >= maxDepth) continue;
      const wanted =
        depth === 0
          ? (['implements'] as readonly string[])
          : (APPROACH_PARENT_EDGE_TYPES as readonly string[]);

      for (const e of index.in.get(id) || []) {
        if (!wanted.includes(e.type)) continue;
        if (visited.has(e.fromId)) continue;
        const node = index.nodes.get(e.fromId);
        if (!node) continue; // archived or filtered out
        visited.add(e.fromId);

        const res = deriveStatus(node.id, index, node.trigger);
        const isApproach = node.trigger === APPROACH_TRIGGER;
        out.push({
          id: node.id,
          name: node.title,
          trigger: node.trigger,
          depth: depth + 1,
          parentId: id,
          via: e.type,
          linkWhy: e.why,
          status: res.status,
          closedBy: res.closedBy,
          isApproach,
        });
        if (isApproach) next.push({ id: node.id, depth: depth + 1 });
      }
    }
    frontier = next;
  }

  out.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  return out;
}

/** Has something replaced this node? An incoming `supersedes` edge says yes. */
export function isSuperseded(nodeId: string, index: GraphIndex): boolean {
  return (index.in.get(nodeId) || []).some((e) => e.type === 'supersedes');
}

export interface ResolveFailure {
  error: string;
  candidates: string[];
  /** True when the reference matched several nodes rather than none. */
  ambiguous: boolean;
}

/**
 * Resolve a claim reference: an exact node id, or the stable id that leads the
 * title ("H10" matches "H10 · …"). Title matching is what the convention
 * actually relies on, so it has to work here.
 *
 * Resolution is TIERED, and the tiers matter — without them a graph that
 * contains "H16 · …" (the claim), "H16/1 · …" (an approach mistyped as a
 * prediction) and "H16 REFUTED …" (commentary) makes "H16" unresolvable even
 * though exactly one node is canonically named H16:
 *
 *   1. exact node id;
 *   2. CANONICAL form — the title is "<ref> · …", the shape the convention
 *      prescribes. This is what an agent means by "H16";
 *   3. token prefix — "<ref>" followed by anything that is not another
 *      identifier character ("H20-Б · …", "H15 is UNTESTED …").
 *
 * The first tier that matches anything wins; deeper tiers are never consulted,
 * so a well-formed title always beats a loosely-related one. Inside a tier the
 * layer the reference asks for is preferred (claim triggers for "H16",
 * `experiment` for "H16/1").
 *
 * When a tier still holds several nodes the reference is genuinely AMBIGUOUS —
 * two claims really do share one number — and this returns an error naming
 * every candidate. It never picks one silently: choosing for the caller is how
 * an approach tree gets attributed to the wrong claim.
 */
export function resolveClaim(
  ref: string,
  index: GraphIndex,
): { id: string; name: string } | ResolveFailure {
  const direct = index.nodes.get(ref);
  if (direct) return { id: direct.id, name: direct.title };

  const needle = ref.trim().toLowerCase();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // "H16 · …" / "H16/1 · …" — the canonical shape, separator included.
  const canonicalRe = new RegExp(`^\\s*${escaped}\\s*[·•]`, 'i');

  const startsWithId = (title: string) => {
    const t = title.trim().toLowerCase();
    if (!t.startsWith(needle)) return false;
    const rest = t.slice(needle.length);
    // "H10" must not match "H100 · …": the id has to be followed by a
    // separator, not by more identifier characters.
    return rest === '' || !/^[a-z0-9]/.test(rest);
  };

  const all = [...index.nodes.values()];
  const canonical = all.filter((n) => canonicalRe.test(n.title));
  const byPrefix = canonical.length > 0 ? canonical : all.filter((n) =>
    startsWithId(n.title),
  );
  const tier = canonical.length > 0 ? 'canonical' : 'prefix';

  const describe = (n: GraphIndexNode) =>
    `${n.id} [${n.trigger ?? 'no trigger'}, created ${n.createdAt}] — ${n.title}`;

  if (byPrefix.length === 1) {
    return { id: byPrefix[0].id, name: byPrefix[0].title };
  }
  if (byPrefix.length > 1) {
    // Prefer the layer the reference asks for: an approach reference ("H10/2")
    // wants trigger `experiment`, a claim reference wants prediction/question.
    const wantsApproach = needle.includes('/');
    const preferred = byPrefix.filter((n) =>
      wantsApproach
        ? n.trigger === APPROACH_TRIGGER
        : (CLAIM_TRIGGERS as readonly string[]).includes(n.trigger ?? ''),
    );
    if (preferred.length === 1) {
      return { id: preferred[0].id, name: preferred[0].title };
    }
    let shortlist = preferred.length > 1 ? preferred : byPrefix;

    // A re-specification KEEPS the identifier — that is what `supersedes`
    // means — so an id shared between a claim and the version that replaced it
    // is not a collision: the live head is what "H10" refers to now, and the
    // superseded one stays reachable by node id and through history.
    const live = shortlist.filter((n) => !isSuperseded(n.id, index));
    if (live.length === 1) return { id: live[0].id, name: live[0].title };
    if (live.length > 1) shortlist = live;
    return {
      ambiguous: true,
      error:
        `AMBIGUOUS IDENTIFIER: "${ref}" names ${shortlist.length} different nodes ` +
        `(matched on the ${tier} form of the title). This is a real collision in the ` +
        'corpus — two nodes were written with the same stable id — not a typo in your ' +
        'query. Pick the one you mean by node id; they are listed below with their ' +
        'trigger and creation date.',
      candidates: shortlist.slice(0, 10).map(describe),
    };
  }

  const contains = all.filter((n) => n.title.toLowerCase().includes(needle));
  return {
    ambiguous: false,
    error: `No node found for "${ref}".`,
    candidates: contains.slice(0, 10).map(describe),
  };
}

/** Same project-resolution rules the reflection tools use. */
function resolveProject(
  requested: string | undefined,
  contextManager: ContextManager,
): { projectId: string; isExternal: boolean } {
  const current = contextManager.getCurrentProjectId();
  const target = requested || current;
  if (target === current) return { projectId: current, isExternal: false };
  if (!isProjectLoaded(target)) {
    return { projectId: current, isExternal: false };
  }
  return { projectId: target, isExternal: true };
}

export const layerTools: Tool[] = [
  {
    name: 'graph_approaches',
    description:
      'SECOND LAYER: the tree of ways one claim has been attacked. Returns every approach node linked to the claim by an `implements` edge, plus their children via `learned_from`/`refines`, each with a status derived from the topology (open / refuted / confirmed / superseded) and, when closed, the `why` of the edge that closed it. A failed APPROACH is not a failed CLAIM — this is the query that keeps the two apart. Returns an empty tree (not an error) for claims that have no approach layer.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description:
            'Node id of the claim, or the stable id leading its title (e.g. "H10" for "H10 · ...").',
        },
        maxDepth: {
          type: 'number',
          description: 'How deep to walk the approach tree (default 5).',
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include archived nodes (default: false)',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['claim'],
    },
  },
  {
    name: 'graph_frontier',
    description:
      'THE FRONTIER IN ONE CALL: open claims (predictions/questions with no adjudicating edge) AND open approaches (experiment nodes with no adjudicating edge), with each approach attributed to the claim it implements. Answers both "what is not yet established?" and "what has not yet been tried on it?". Claims with no open approach are called out separately — those are the ones needing a new way in. Use this to open an inspiration/planning stage.',
    inputSchema: {
      type: 'object',
      properties: {
        claimTriggers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Triggers treated as layer-1 claims (default: ["prediction","question"]).',
        },
        limit: {
          type: 'number',
          description: 'Max claims and max approaches to return (default 30).',
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include archived nodes (default: false)',
        },
        titleContains: {
          type: 'string',
          description:
            'Only claims whose title contains this string (case-insensitive). Useful to scope to one hypothesis family.',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
    },
  },
  {
    name: 'graph_next_id',
    description:
      'ISSUE A STABLE IDENTIFIER. Returns the next free claim id ("H25"), or — with `claim` — the next free approach id under that claim ("H12/4"), read from the graph as it is right now. Use it before writing a claim or an approach instead of guessing the number from what you last read: two cycles that both guessed produced two different claims both called H21, and neither can be reached by name any more. ADVISORY ONLY: graph_batch is the authority and re-issues the number at commit time if this one was taken in the meantime, so a batch written from a stale answer is corrected rather than colliding. Also reports the identifiers that already collide.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description:
            'Node id or stable id of the claim to number an approach under. Omit to get the next free CLAIM id.',
        },
        includeArchived: {
          type: 'boolean',
          description: 'Include archived nodes (default: false)',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
    },
  },
];

export async function handleLayerTools(
  name: string,
  args: Record<string, unknown>,
  contextManager: ContextManager,
): Promise<unknown> {
  const { projectId, isExternal } = resolveProject(
    args.project as string | undefined,
    contextManager,
  );
  const includeArchived = args.includeArchived === true;
  const index = loadGraphIndex(projectId, includeArchived);

  switch (name) {
    case 'graph_approaches': {
      const resolved = resolveClaim(args.claim as string, index);
      if ('error' in resolved) {
        return {
          success: false,
          project: projectId,
          ambiguous: resolved.ambiguous,
          error: resolved.error,
          candidates: resolved.candidates,
          hint: resolved.ambiguous
            ? 'Call graph_approaches once per candidate id to see the two trees separately. ' +
              'If they are the same claim written twice, connect one to the other with a ' +
              '`supersedes` edge; if they are different claims, one of them needs a free ' +
              'identifier (graph_next_id issues one). History is not rewritten either way.'
            : 'Pass the node id, or the exact stable id that leads the claim title.',
        };
      }

      const maxDepth =
        typeof args.maxDepth === 'number' && args.maxDepth > 0
          ? Math.floor(args.maxDepth)
          : 5;
      const claimStatus = deriveStatus(
        resolved.id,
        index,
        index.nodes.get(resolved.id)?.trigger,
      );
      const tree = collectApproaches(resolved.id, index, maxDepth);
      const approaches = tree.filter((a) => a.isApproach);
      const open = approaches.filter((a) => a.status === 'open');

      // Two approaches under one claim carrying the same "/k" are two
      // different attempts that cannot be told apart by name — in the prose of
      // a later cycle, "H17/1 failed" then means nothing definite.
      const byStableId = new Map<string, string[]>();
      for (const a of approaches) {
        const parsed = parseStableId(a.name);
        if (!parsed || parsed.claimNum === null || parsed.approachNum === null)
          continue;
        const key = formatStableId(parsed.claimNum, parsed.approachNum);
        const bucket = byStableId.get(key);
        if (bucket) bucket.push(a.id);
        else byStableId.set(key, [a.id]);
      }
      const duplicateApproachIds = [...byStableId.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([stableId, ids]) => ({ stableId, nodes: ids }));

      return {
        project: projectId,
        isExternal,
        claim: {
          id: resolved.id,
          name: resolved.name,
          trigger: index.nodes.get(resolved.id)?.trigger ?? null,
          status: claimStatus.status,
          closedBy: claimStatus.closedBy,
        },
        counts: {
          approaches: approaches.length,
          open: open.length,
          refuted: approaches.filter((a) => a.status === 'refuted').length,
          confirmed: approaches.filter((a) => a.status === 'confirmed').length,
          other: tree.length - approaches.length,
        },
        duplicateApproachIds:
          duplicateApproachIds.length > 0 ? duplicateApproachIds : undefined,
        tree,
        hint:
          tree.length === 0
            ? 'No approach layer under this claim. Nothing has been recorded as a way to establish it — an approach node (trigger "experiment", `implements` edge to this claim) is the missing piece.'
            : claimStatus.status === 'refuted' && open.length > 0
              ? `WARNING: this claim is marked refuted while ${open.length} approach(es) under it are still open. A failed approach is not a failed claim — check that the refutation really settles the claim itself.`
              : open.length === 0
                ? 'Every approach under this claim is closed. Either the claim itself can be adjudicated, or it needs a genuinely new way in.'
                : `${open.length} open approach(es) — these are the ways to establish this claim that are still live.`,
      };
    }

    case 'graph_frontier': {
      const limit =
        typeof args.limit === 'number' && args.limit > 0
          ? Math.floor(args.limit)
          : 30;
      const claimTriggers = Array.isArray(args.claimTriggers)
        ? (args.claimTriggers as string[])
        : [...CLAIM_TRIGGERS];
      const titleContains =
        typeof args.titleContains === 'string'
          ? args.titleContains.toLowerCase()
          : undefined;

      const allNodes = [...index.nodes.values()];

      const openClaimNodes = allNodes
        .filter((n) => n.trigger && claimTriggers.includes(n.trigger))
        .filter(
          (n) =>
            !titleContains || n.title.toLowerCase().includes(titleContains),
        )
        .filter((n) => isOpen(n.id, index, n.trigger))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      // Approaches, attributed to the claim each one serves — directly via
      // `implements`, or through the parent chain for a nested approach.
      const approachNodes = allNodes.filter(
        (n) => n.trigger === APPROACH_TRIGGER,
      );
      const claimOf = new Map<string, ReturnType<typeof claimOfApproach>>();
      for (const a of approachNodes) {
        claimOf.set(a.id, claimOfApproach(a.id, index));
      }

      const openApproaches = approachNodes
        .filter((n) => isOpen(n.id, index, n.trigger))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      const openApproachIdsByClaim = new Map<string, number>();
      for (const a of openApproaches) {
        const c = claimOf.get(a.id);
        if (!c) continue;
        openApproachIdsByClaim.set(
          c.id,
          (openApproachIdsByClaim.get(c.id) || 0) + 1,
        );
      }

      const claimsNeedingAnApproach = openClaimNodes
        .filter((c) => !openApproachIdsByClaim.get(c.id))
        .slice(0, limit)
        .map((c) => ({ id: c.id, name: c.title, trigger: c.trigger }));

      const unattached = openApproaches.filter((a) => !claimOf.get(a.id));

      // Stable-id collisions: two claims (or two approaches) written with the
      // same identifier. They are invisible in every per-node view and they
      // make `graph_approaches("H21")` unanswerable, so the frontier — the one
      // call every planning stage makes — is where they have to surface.
      const idCollisions = findIdCollisions(scanStableIds(index), index);

      // Approaches that declare themselves a way of testing more than one
      // claim. Attribution picks the first edge, so the rest are invisible
      // everywhere else.
      const ambiguouslyAttributed = approachNodes
        .map((a) => {
          const c = claimOf.get(a.id);
          if (!c?.alsoImplements) return null;
          return {
            id: a.id,
            name: a.title,
            claims: [{ id: c.id, name: c.name }, ...c.alsoImplements],
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Open approaches whose claim has ALREADY been adjudicated: the exact
      // wreckage of "a failed approach read as a failed idea". Each one is a
      // live way of testing something someone already declared settled.
      const strandedByAVerdict = openApproaches
        .map((a) => {
          const c = claimOf.get(a.id);
          if (!c) return null;
          const st = deriveStatus(c.id, index);
          if (st.status === 'open') return null;
          return {
            id: a.id,
            name: a.title,
            claim: { id: c.id, name: c.name },
            claimStatus: st.status,
            claimClosedBy: st.closedBy,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      return {
        project: projectId,
        isExternal,
        counts: {
          openClaims: openClaimNodes.length,
          openApproaches: openApproaches.length,
          approachesTotal: approachNodes.length,
          claimsWithNoOpenApproach: openClaimNodes.filter(
            (c) => !openApproachIdsByClaim.get(c.id),
          ).length,
          openApproachesWithNoClaim: unattached.length,
          openApproachesUnderClosedClaims: strandedByAVerdict.length,
          collidingIdentifiers: idCollisions.length,
          approachesImplementingSeveralClaims: ambiguouslyAttributed.length,
        },
        collidingIdentifiers: idCollisions,
        approachesImplementingSeveralClaims: ambiguouslyAttributed,
        openClaims: openClaimNodes.slice(0, limit).map((c) => ({
          id: c.id,
          name: c.title,
          trigger: c.trigger,
          openApproaches: openApproachIdsByClaim.get(c.id) || 0,
          createdAt: c.createdAt,
        })),
        openApproaches: openApproaches.slice(0, limit).map((a) => ({
          id: a.id,
          name: a.title,
          claim: claimOf.get(a.id) ?? null,
          createdAt: a.createdAt,
        })),
        claimsNeedingAnApproach,
        openApproachesUnderClosedClaims: strandedByAVerdict.slice(0, limit),
        hint:
          openClaimNodes.length === 0 && approachNodes.length === 0
            ? 'Neither layer is populated in this project yet.'
            : `openClaims = not established. openApproaches = ways still live. claimsNeedingAnApproach = open claims with nothing live under them: either invent an approach or close the claim. openApproachesWithNoClaim counts experiment nodes missing an \`implements\` edge — they belong to no claim and will be lost.${
                strandedByAVerdict.length > 0
                  ? ` ⚠️ openApproachesUnderClosedClaims (${strandedByAVerdict.length}): live ways of testing a claim someone already declared settled — re-open the claim or close these explicitly, with a reason.`
                  : ''
              }${
                idCollisions.length > 0
                  ? ` ⚠️ collidingIdentifiers (${idCollisions.length}): ${idCollisions
                      .map((c) => c.stableId)
                      .join(', ')} each name more than one node, so those ids cannot be resolved by name at all. New nodes now get their number from the engine; these are the pre-existing ones and they are left exactly as written.`
                  : ''
              }`,
      };
    }

    case 'graph_next_id': {
      const scan = scanStableIds(index);
      const collisions = findIdCollisions(scan, index);
      const ref = typeof args.claim === 'string' ? args.claim.trim() : '';

      if (!ref) {
        const num = nextFreeClaimNum(scan);
        return {
          project: projectId,
          isExternal,
          nextClaimId: formatStableId(num),
          highestInUse: scan.maxClaimNum > 0 ? `H${scan.maxClaimNum}` : null,
          claimsInUse: scan.claims.size,
          collidingIdentifiers: collisions,
          hint:
            `Title the claim "${formatStableId(num)} · <the claim, stated so it can fail>" and give it ` +
            'trigger `prediction` (or `question`). Numbers are never re-used, so a gap is a deleted ' +
            'claim, not a free slot. If another writer takes this number first, graph_batch will ' +
            'issue you the next one at commit time and say so in its result.',
        };
      }

      const resolved = resolveClaim(ref, index);
      if ('error' in resolved) {
        return {
          success: false,
          project: projectId,
          ambiguous: resolved.ambiguous,
          error: resolved.error,
          candidates: resolved.candidates,
          hint: 'Pass the node id of the claim you mean.',
        };
      }
      const parsed = parseStableId(resolved.name);
      if (!parsed || parsed.claimNum === null) {
        return {
          success: false,
          project: projectId,
          error: `"${resolved.name.slice(0, 80)}" carries no canonical stable id ("H<n> · …"), so approaches under it cannot be numbered.`,
          hint: 'Give the claim a canonical title first (graph_revise), or attach the approach by `implements` edge alone.',
        };
      }
      const k = nextFreeApproachNum(scan, parsed.claimNum);
      const existing = [...scan.approaches.entries()]
        .filter(([key]) => key.startsWith(`${parsed.claimNum}/`))
        .flatMap(([key, nodes]) => nodes.map((n) => `H${key} — ${n.id}`))
        .sort();
      return {
        project: projectId,
        isExternal,
        claim: { id: resolved.id, name: resolved.name },
        nextApproachId: formatStableId(parsed.claimNum, k),
        existingApproaches: existing,
        collidingIdentifiers: collisions.filter((c) =>
          c.stableId.startsWith(`H${parsed.claimNum}/`),
        ),
        hint:
          `Title the approach "${formatStableId(parsed.claimNum, k)} · <what this attempt actually does>", ` +
          `trigger \`experiment\`, and connect it to ${resolved.id} with an \`implements\` edge in the ` +
          'same batch — the edge is what makes it layer 2; the number only makes it readable.',
      };
    }

    default:
      throw new Error(`Unknown layer tool: ${name}`);
  }
}

/**
 * Guard against the single most expensive mistake this layering exists to
 * prevent: marking a CLAIM refuted while ways of establishing it are still
 * open. It is a warning, never a refusal — a claim can be refuted directly,
 * bypassing its approaches — but it must never pass silently.
 *
 * Called after a batch commits, over the edges the batch actually created, so
 * it sees `$0.id` references already resolved.
 */
export function checkPrematureInvalidation(
  projectId: string,
  edgeIds: string[],
): Array<{
  edgeId: string;
  claimId: string;
  claimName: string;
  openApproaches: Array<{ id: string; name: string }>;
  message: string;
}> {
  if (edgeIds.length === 0) return [];

  let index: GraphIndex;
  try {
    index = loadGraphIndex(projectId);
  } catch {
    return []; // never let a diagnostic break a committed batch
  }

  const store = getGraphStore();
  const warnings: Array<{
    edgeId: string;
    claimId: string;
    claimName: string;
    openApproaches: Array<{ id: string; name: string }>;
    message: string;
  }> = [];

  for (const edgeId of edgeIds) {
    let edge: { toId: string; type: string } | null | undefined;
    try {
      edge = store.getEdge(edgeId) as { toId: string; type: string } | null;
    } catch {
      edge = null;
    }
    if (!edge || edge.type !== 'invalidates') continue;

    const claim = index.nodes.get(edge.toId);
    if (!claim) continue;

    const tree = collectApproaches(claim.id, index);
    const openOnes = tree.filter((a) => a.isApproach && a.status === 'open');
    if (openOnes.length === 0) continue;

    warnings.push({
      edgeId,
      claimId: claim.id,
      claimName: claim.title,
      openApproaches: openOnes.map((a) => ({ id: a.id, name: a.name })),
      message:
        `"${claim.title}" was just marked INVALIDATED, but ${openOnes.length} approach(es) under it are still open. ` +
        'A failed APPROACH is not a failed CLAIM. If only one way of testing it failed, invalidate that approach instead ' +
        '(and record the next approach), or say explicitly in the edge `why` that the claim itself is refuted regardless of the remaining approaches.',
    });
  }

  return warnings;
}
