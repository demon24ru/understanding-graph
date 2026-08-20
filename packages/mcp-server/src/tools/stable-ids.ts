/**
 * STABLE IDENTIFIERS — "H12", "H12/3" — allocated by the engine, not guessed
 * by the writer.
 *
 * WHY THIS EXISTS
 * ---------------
 * The two-layer convention puts the identity of a claim in its title
 * ("H21 - ..."), and the identity of an approach under it in the approach's
 * title ("H21/1 - ..."). Nothing allocated those numbers: every agent picked
 * the next one by looking at what it happened to see. Two cycles a day apart
 * both saw H20 as the maximum and both wrote H21, so one identifier now names
 * two unrelated claims, and each of them has its own "H21/1". With parallel
 * subagents writing into one graph that is the expected outcome, not bad luck.
 *
 * The rule this module implements: the number is issued at creation time,
 * inside the same transaction that creates the node, from the state of the
 * graph at that moment. An agent may still propose one - it will be honoured
 * when it is free, and corrected (loudly, in the batch result) when it is not.
 *
 * SCOPE - deliberately narrow, because a title rewrite is destructive if it
 * fires on the wrong node:
 *   - only the CANONICAL form is managed: "H<n> - " / "H<n>/<k> - " with the
 *     middle dot separator the convention uses;
 *   - only on LAYER nodes: trigger prediction/question for a claim, experiment
 *     for an approach. A node titled "H15 REFUTED-AS-STATED ..." with trigger
 *     `analysis` is commentary ABOUT H15 and is never renumbered;
 *   - never on graph_supersede, and never when the same batch draws a
 *     `supersedes` edge at the node it collides with: re-using the identifier
 *     is the whole point of a re-specification.
 * Everything outside that scope is reported, never rewritten.
 */

import type { GraphIndex } from './layers.js';

/** The separator the convention uses between the id and the prose. */
const CANONICAL_SEPARATORS = '·•';

/**
 * "H12 - ...", "H12/3 - ...", and the placeholder forms "H? - ..." /
 * "H12/? - ..." an agent can write to ask the engine for a number.
 */
const CANONICAL_ID_RE = new RegExp(
  `^(\\s*)H(\\d+|[?#*])(?:/(\\d+|[?#*]))?(\\s*[${CANONICAL_SEPARATORS}])`,
  'i',
);

const PLACEHOLDERS = new Set(['?', '#', '*']);

export const CLAIM_LAYER_TRIGGERS = ['prediction', 'question'] as const;
export const APPROACH_LAYER_TRIGGER = 'experiment';

export interface ParsedStableId {
  /** Claim number, or null when the writer asked for one with a placeholder. */
  claimNum: number | null;
  /** Approach number; null when the title carries no "/k" part at all. */
  approachNum: number | null;
  /** True when "/k" was present but written as a placeholder. */
  approachRequested: boolean;
  /** Characters of the title consumed by the id and its separator. */
  matchLength: number;
  /** Leading whitespace + the separator run, so a rewrite preserves spacing. */
  lead: string;
  tail: string;
}

/** Parse the canonical leading identifier of a title, or null if absent. */
export function parseStableId(title: string): ParsedStableId | null {
  if (!title) return null;
  const m = CANONICAL_ID_RE.exec(title);
  if (!m) return null;
  const [, lead, rawClaim, rawApproach, sep] = m;
  const claimIsPlaceholder = PLACEHOLDERS.has(rawClaim);
  const approachIsPlaceholder =
    rawApproach !== undefined && PLACEHOLDERS.has(rawApproach);
  return {
    claimNum: claimIsPlaceholder ? null : Number.parseInt(rawClaim, 10),
    approachNum:
      rawApproach === undefined || approachIsPlaceholder
        ? null
        : Number.parseInt(rawApproach, 10),
    approachRequested: rawApproach !== undefined,
    matchLength: m[0].length,
    lead,
    tail: sep,
  };
}

/** Render "H12" / "H12/3". */
export function formatStableId(
  claimNum: number,
  approachNum?: number | null,
): string {
  return approachNum == null ? `H${claimNum}` : `H${claimNum}/${approachNum}`;
}

/** Replace the leading identifier of a title, keeping the prose untouched. */
export function retitle(
  title: string,
  parsed: ParsedStableId,
  claimNum: number,
  approachNum: number | null,
): string {
  const id = formatStableId(claimNum, approachNum);
  return `${parsed.lead}${id}${parsed.tail}${title.slice(parsed.matchLength)}`;
}

export interface StableIdNode {
  id: string;
  title: string;
  trigger: string | null;
  createdAt: string;
  claimNum: number;
  approachNum: number | null;
}

export interface StableIdScan {
  /** Claim-layer nodes (prediction/question) by claim number. */
  claims: Map<number, StableIdNode[]>;
  /** Approach-layer nodes (experiment) by "n/k". */
  approaches: Map<string, StableIdNode[]>;
  /** Every canonically-titled node, whatever its trigger. */
  all: StableIdNode[];
  /** Highest claim number in use by anything canonically titled. */
  maxClaimNum: number;
}

function isClaimTrigger(t: string | null): boolean {
  return t === 'prediction' || t === 'question';
}

/**
 * Every canonically-titled node in the graph, bucketed by identifier.
 * Non-layer triggers are kept in `all` (so their numbers are not handed out
 * again) but never in `claims` / `approaches` (so they cannot make a lookup
 * ambiguous, and are never renumbered).
 */
export function scanStableIds(index: GraphIndex): StableIdScan {
  const claims = new Map<number, StableIdNode[]>();
  const approaches = new Map<string, StableIdNode[]>();
  const all: StableIdNode[] = [];
  let maxClaimNum = 0;

  for (const n of index.nodes.values()) {
    const parsed = parseStableId(n.title);
    if (!parsed || parsed.claimNum === null) continue;
    const entry: StableIdNode = {
      id: n.id,
      title: n.title,
      trigger: n.trigger,
      createdAt: n.createdAt,
      claimNum: parsed.claimNum,
      approachNum: parsed.approachNum,
    };
    all.push(entry);
    if (entry.claimNum > maxClaimNum) maxClaimNum = entry.claimNum;

    if (entry.approachNum === null) {
      if (isClaimTrigger(entry.trigger)) {
        const bucket = claims.get(entry.claimNum);
        if (bucket) bucket.push(entry);
        else claims.set(entry.claimNum, [entry]);
      }
    } else if (entry.trigger === APPROACH_LAYER_TRIGGER) {
      const key = `${entry.claimNum}/${entry.approachNum}`;
      const bucket = approaches.get(key);
      if (bucket) bucket.push(entry);
      else approaches.set(key, [entry]);
    }
  }

  return { claims, approaches, all, maxClaimNum };
}

export interface IdCollision {
  stableId: string;
  layer: 'claim' | 'approach';
  nodes: Array<{
    id: string;
    title: string;
    trigger: string | null;
    createdAt: string;
  }>;
}

/** Has something replaced this node? An incoming `supersedes` edge says yes. */
function supersededIn(index: GraphIndex | undefined, nodeId: string): boolean {
  if (!index) return false;
  return (index.in.get(nodeId) || []).some((e) => e.type === 'supersedes');
}

/**
 * Identifiers that name more than one node of the same layer.
 *
 * A re-specification keeps its identifier on purpose, so when `index` is given
 * the superseded versions are dropped first: "H10" held by a claim and by the
 * claim that replaced it is one hypothesis with a history, not two claims
 * fighting over a number.
 */
export function findIdCollisions(
  scan: StableIdScan,
  index?: GraphIndex,
): IdCollision[] {
  const out: IdCollision[] = [];
  const live = (nodes: StableIdNode[]) =>
    nodes.filter((n) => !supersededIn(index, n.id));
  const describe = (n: StableIdNode) => ({
    id: n.id,
    title: n.title.length > 160 ? `${n.title.slice(0, 157)}...` : n.title,
    trigger: n.trigger,
    createdAt: n.createdAt,
  });

  for (const [num, nodes] of scan.claims) {
    const remaining = live(nodes);
    if (remaining.length > 1) {
      out.push({
        stableId: `H${num}`,
        layer: 'claim',
        nodes: remaining.map(describe),
      });
    }
  }
  for (const [key, nodes] of scan.approaches) {
    const remaining = live(nodes);
    if (remaining.length > 1) {
      out.push({
        stableId: `H${key}`,
        layer: 'approach',
        nodes: remaining.map(describe),
      });
    }
  }
  out.sort((a, b) => a.stableId.localeCompare(b.stableId, 'en', {
    numeric: true,
  }));
  return out;
}

/**
 * Next claim number that no canonically-titled node uses. Deliberately global
 * (not "max claim + 1"): a number whose approaches exist must not be handed
 * out again even if the claim itself was archived.
 */
export function nextFreeClaimNum(
  scan: StableIdScan,
  alsoTaken: Set<number> = new Set(),
): number {
  const taken = new Set<number>(alsoTaken);
  for (const n of scan.all) taken.add(n.claimNum);
  // Start above the high-water mark rather than filling gaps: a gap usually
  // means an archived or deleted claim, and re-issuing its number would make
  // the history read as one hypothesis when it is two.
  let candidate = scan.maxClaimNum + 1;
  while (taken.has(candidate)) candidate++;
  return candidate;
}

/** Next free approach number under one claim number. */
export function nextFreeApproachNum(
  scan: StableIdScan,
  claimNum: number,
  alsoTaken: Set<string> = new Set(),
): number {
  let k = 1;
  while (
    scan.approaches.has(`${claimNum}/${k}`) ||
    alsoTaken.has(`${claimNum}/${k}`)
  ) {
    k++;
  }
  return k;
}

// ---------------------------------------------------------------------------
// Allocation over a batch, before it executes
// ---------------------------------------------------------------------------

export interface BatchOperation {
  tool: string;
  params: Record<string, unknown>;
}

export interface IdAllocation {
  operationIndex: number;
  field: string;
  proposed: string;
  assigned: string;
  reason: 'collision' | 'requested' | 'claim-mismatch';
  detail: string;
}

export interface IdConventionNote {
  operationIndex: number;
  message: string;
}

export interface AllocationResult {
  allocations: IdAllocation[];
  notes: IdConventionNote[];
}

/** Which parameter carries the title, per node-creating tool. */
function titleFieldFor(tool: string): string | null {
  switch (tool) {
    case 'graph_add_concept':
    case 'graph_serendipity':
      return 'title';
    case 'graph_question':
      return 'question';
    default:
      // graph_supersede and graph_answer are excluded on purpose: the first
      // re-uses an identifier by design, the second writes an answer, not a
      // claim. doc_create is not a layer node.
      return null;
  }
}

function triggerFor(op: BatchOperation): string | null {
  if (op.tool === 'graph_question') return 'question';
  const t = op.params.trigger;
  return typeof t === 'string' ? t : null;
}

/**
 * Assign stable identifiers to the layer nodes a batch is about to create,
 * MUTATING the operations in place, and report every assignment.
 *
 * Called inside graph_batch's pre-validation, so the numbers come from the
 * graph as it is at commit time rather than from what the agent read minutes
 * ago in another session.
 */
export function allocateStableIdsForBatch(
  operations: BatchOperation[],
  index: GraphIndex,
): AllocationResult {
  const scan = scanStableIds(index);
  const allocations: IdAllocation[] = [];
  const notes: IdConventionNote[] = [];

  // Numbers this batch has already handed out.
  const claimNumsTakenHere = new Set<number>();
  const approachKeysTakenHere = new Set<string>();
  // operation index -> claim number that op's new claim node ended up with.
  const claimNumOfOp = new Map<number, number>();

  // A `supersedes` edge drawn in this batch legitimises re-using an id.
  const supersedeTargetsOf = new Map<number, Set<string>>();
  for (const op of operations) {
    if (op.tool !== 'graph_connect') continue;
    if (String(op.params.type ?? '') !== 'supersedes') continue;
    const from = String(op.params.from ?? op.params.fromId ?? '');
    const to = String(op.params.to ?? op.params.toId ?? '');
    const m = /^\$(\d+)\.id$/.exec(from);
    if (!m || !to) continue;
    const idx = Number.parseInt(m[1], 10);
    const set = supersedeTargetsOf.get(idx) ?? new Set<string>();
    set.add(to);
    supersedeTargetsOf.set(idx, set);
  }

  // `implements` edges: an approach's claim number comes from the claim it
  // implements, not from what the writer typed.
  const implementsTargetOf = new Map<number, string>();
  for (const op of operations) {
    if (op.tool !== 'graph_connect') continue;
    if (String(op.params.type ?? '') !== 'implements') continue;
    const from = String(op.params.from ?? op.params.fromId ?? '');
    const to = String(op.params.to ?? op.params.toId ?? '');
    const m = /^\$(\d+)\.id$/.exec(from);
    if (!m || !to) continue;
    implementsTargetOf.set(Number.parseInt(m[1], 10), to);
  }

  const claimNumOfExistingNode = (ref: string): number | null => {
    const node = index.nodes.get(ref);
    if (!node) return null;
    const parsed = parseStableId(node.title);
    return parsed?.claimNum ?? null;
  };

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const field = titleFieldFor(op.tool);
    if (!field) continue;
    const title = op.params[field];
    if (typeof title !== 'string') continue;
    const parsed = parseStableId(title);
    if (!parsed) continue;

    const trigger = triggerFor(op);
    const wantsApproach = parsed.approachRequested;

    // Convention check first: report, never rewrite, when the trigger and the
    // shape of the id disagree. Renumbering a node whose layer we cannot trust
    // would be worse than leaving the number alone.
    if (wantsApproach && trigger !== APPROACH_LAYER_TRIGGER) {
      notes.push({
        operationIndex: i,
        message:
          `"${title.slice(0, 60)}..." carries an APPROACH id but trigger "${trigger ?? 'none'}". ` +
          'Layer 2 is trigger "experiment"; the identifier was left exactly as written.',
      });
      continue;
    }
    if (!wantsApproach && !isClaimTrigger(trigger)) {
      // Commentary about a claim ("H15 REFUTED ...", trigger analysis) lands
      // here. That is legitimate and must not be renumbered.
      continue;
    }

    if (wantsApproach) {
      // --- Layer 2 -------------------------------------------------------
      let claimNum = parsed.claimNum;
      let reason: IdAllocation['reason'] | null = null;
      let detail = '';

      const target = implementsTargetOf.get(i);
      if (target) {
        const m = /^\$(\d+)\.id$/.exec(target);
        const fromBatch = m
          ? claimNumOfOp.get(Number.parseInt(m[1], 10))
          : undefined;
        const fromGraph = m ? null : claimNumOfExistingNode(target);
        const resolved = fromBatch ?? fromGraph ?? null;
        if (resolved !== null && resolved !== claimNum) {
          reason = 'claim-mismatch';
          detail =
            `the \`implements\` edge in this batch points at H${resolved}, ` +
            `not H${parsed.claimNum ?? '?'}; the approach follows its claim`;
          claimNum = resolved;
        } else if (resolved !== null) {
          claimNum = resolved;
        }
      }

      if (claimNum === null) {
        notes.push({
          operationIndex: i,
          message:
            'Approach title asks for a claim number ("H?/...") but the batch has no ' +
            '`implements` edge to read it from. Left as written.',
        });
        continue;
      }

      const proposedKey =
        parsed.approachNum === null ? null : `${claimNum}/${parsed.approachNum}`;
      const collides =
        proposedKey !== null &&
        (scan.approaches.has(proposedKey) ||
          approachKeysTakenHere.has(proposedKey));

      let approachNum = parsed.approachNum;
      if (approachNum === null) {
        approachNum = nextFreeApproachNum(scan, claimNum, approachKeysTakenHere);
        reason = reason ?? 'requested';
        detail = detail || 'the writer left the approach number to the engine';
      } else if (collides) {
        const clash = scan.approaches.get(proposedKey as string) ?? [];
        approachNum = nextFreeApproachNum(scan, claimNum, approachKeysTakenHere);
        reason = 'collision';
        detail =
          `H${proposedKey} already names ${clash.length || 1} other approach` +
          (clash[0] ? ` (${clash[0].id})` : '');
      }

      approachKeysTakenHere.add(`${claimNum}/${approachNum}`);
      const assigned = formatStableId(claimNum, approachNum);
      const proposed = formatStableId(
        parsed.claimNum ?? claimNum,
        parsed.approachNum,
      );
      if (reason && assigned !== proposed) {
        op.params[field] = retitle(title, parsed, claimNum, approachNum);
        allocations.push({
          operationIndex: i,
          field,
          proposed,
          assigned,
          reason,
          detail,
        });
      }
      continue;
    }

    // --- Layer 1 ---------------------------------------------------------
    let claimNum = parsed.claimNum;
    if (claimNum !== null) {
      // Only claims that are still the live head of their chain hold a number:
      // a claim already replaced by a `supersedes` edge has handed its
      // identifier on, and blocking the number on its account would be wrong.
      const existing = (scan.claims.get(claimNum) ?? []).filter(
        (n) => !supersededIn(index, n.id),
      );
      const supersedes = supersedeTargetsOf.get(i) ?? new Set<string>();
      const reusingDeliberately = existing.some(
        (n) => supersedes.has(n.id) || supersedes.has(n.title),
      );
      const collides =
        (existing.length > 0 && !reusingDeliberately) ||
        claimNumsTakenHere.has(claimNum);

      if (collides) {
        const assignedNum = nextFreeClaimNum(scan, claimNumsTakenHere);
        const clash = existing[0];
        op.params[field] = retitle(title, parsed, assignedNum, null);
        allocations.push({
          operationIndex: i,
          field,
          proposed: `H${claimNum}`,
          assigned: `H${assignedNum}`,
          reason: 'collision',
          detail: clash
            ? `H${claimNum} already names claim ${clash.id} ("${clash.title.slice(0, 70)}..."), ` +
              'and this batch draws no `supersedes` edge at it, so the two are different claims'
            : `H${claimNum} was already allocated earlier in this same batch`,
        });
        claimNum = assignedNum;
      }
    } else {
      const assignedNum = nextFreeClaimNum(scan, claimNumsTakenHere);
      op.params[field] = retitle(title, parsed, assignedNum, null);
      allocations.push({
        operationIndex: i,
        field,
        proposed: 'H?',
        assigned: `H${assignedNum}`,
        reason: 'requested',
        detail: 'the writer left the claim number to the engine',
      });
      claimNum = assignedNum;
    }

    claimNumsTakenHere.add(claimNum);
    claimNumOfOp.set(i, claimNum);
  }

  return { allocations, notes };
}
