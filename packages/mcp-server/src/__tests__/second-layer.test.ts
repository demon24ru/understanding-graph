import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sqlite } from '@emergent-wisdom/understanding-graph-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextManager } from '../context-manager.js';
import { handleToolCall } from '../tools/index.js';

// The SECOND LAYER: a claim (layer 1) and the tree of approaches that try to
// establish it (layer 2). The distinction is the whole point — a refuted
// APPROACH is not a refuted CLAIM — so these tests pin the three places the
// engine has to keep them apart:
//
//   1. `unresolvedOnly` must filter for EVERY trigger, not just prediction
//      and question. It used to return everything, silently, for the rest.
//   2. `graph_approaches` must report the tree with a status derived from
//      topology and the reason taken from the closing edge's `why`.
//   3. `graph_batch` must WARN (never refuse) when a claim is invalidated
//      while approaches under it are still open.

let tmpDir: string;
let contextManager: ContextManager;

const PROJECT = 'layers';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug-layers-'));
  fs.mkdirSync(path.join(tmpDir, 'projects', PROJECT), { recursive: true });

  contextManager = new ContextManager();
  contextManager.setProjectDir(path.join(tmpDir, 'projects'));
  sqlite.initAllDatabases(path.join(tmpDir, 'projects'));
  if (!sqlite.getLoadedProjectIds().includes(PROJECT)) {
    sqlite.initDatabase(path.join(tmpDir, 'projects', PROJECT));
  }
  sqlite.setCurrentProject(PROJECT);
  await contextManager.switchProject(PROJECT);
});

afterEach(() => {
  try {
    sqlite.closeAllDatabases();
  } catch {
    // already closed
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

type Res = Record<string, unknown>;

async function call(tool: string, args: Record<string, unknown>): Promise<Res> {
  return (await handleToolCall(tool, args, contextManager)) as Res;
}

/** claim H99 with two approaches: H99/1, and H99/2 born of its failure. */
async function seedTwoLayers() {
  const batch = (await call('graph_batch', {
    commit_message: 'seed: one claim, two approaches',
    ignoreWarnings: true,
    operations: [
      {
        tool: 'graph_add_concept',
        params: {
          title: 'CTX root',
          trigger: 'foundation',
          why: 'anchor',
          understanding: 'anchor',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H99 - the claim',
          trigger: 'prediction',
          why: 'layer 1',
          understanding: 'The effect is real.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H99/1 - direct measurement',
          trigger: 'experiment',
          why: 'layer 2',
          understanding: 'Measure X directly.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H99/2 - decomposition',
          trigger: 'experiment',
          why: 'layer 2',
          understanding: 'Split into sub-claims.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_connect',
        params: {
          from: '$1.id',
          to: '$0.id',
          relation: 'sits in',
          type: 'relates',
          why: 'anchor',
        },
      },
      {
        tool: 'graph_connect',
        params: {
          from: '$2.id',
          to: '$1.id',
          relation: 'is a way to test',
          type: 'implements',
          why: 'first way of establishing H99',
        },
      },
      {
        tool: 'graph_connect',
        params: {
          from: '$3.id',
          to: '$2.id',
          relation: 'born from the failure of',
          type: 'learned_from',
          why: 'second way',
        },
      },
    ],
  })) as Res;

  const results = batch.results as Array<{ id: string }>;
  return {
    ctx: results[0].id,
    claim: results[1].id,
    a1: results[2].id,
    a2: results[3].id,
  };
}

async function invalidate(target: string, why: string, title: string) {
  return (await call('graph_batch', {
    commit_message: `refute: ${title}`,
    ignoreWarnings: true,
    operations: [
      {
        tool: 'graph_add_concept',
        params: {
          title,
          trigger: 'evaluation',
          why: 'result',
          understanding: 'measured',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_connect',
        params: {
          from: '$0.id',
          to: target,
          relation: 'refutes',
          type: 'invalidates',
          why,
        },
      },
    ],
  })) as Res;
}

describe('unresolvedOnly is trigger-agnostic', () => {
  it('filters experiment nodes by their adjudicating edges', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'measured X = -0.4, this way is exhausted', 'R1');

    const res = await call('graph_find_by_trigger', {
      trigger: 'experiment',
      unresolvedOnly: true,
    });

    expect(res.total).toBe(2);
    expect(res.filtered).toBe(1);
    const nodes = res.nodes as Array<{ id: string; status: string }>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe(ids.a2);
    expect(nodes[0].status).toBe('open');
  });

  it('leaves the CLAIM open when only an approach was refuted', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'this way is exhausted', 'R1');

    const res = await call('graph_find_by_trigger', {
      trigger: 'prediction',
      unresolvedOnly: true,
    });
    const nodes = res.nodes as Array<{ id: string }>;
    expect(nodes.map((n) => n.id)).toContain(ids.claim);
  });

  it('counts an OUTGOING adjudicating edge as resolved too', async () => {
    const ids = await seedTwoLayers();
    // The approach itself passes judgement on something else.
    await call('graph_batch', {
      commit_message: 'approach two invalidates the claim directly',
      ignoreWarnings: true,
      operations: [
        {
          tool: 'graph_connect',
          params: {
            from: ids.a2,
            to: ids.claim,
            relation: 'refutes',
            type: 'invalidates',
            why: 'ran it, the claim is false',
          },
        },
      ],
    });

    const res = await call('graph_find_by_trigger', {
      trigger: 'experiment',
      unresolvedOnly: true,
    });
    const nodes = res.nodes as Array<{ id: string }>;
    expect(nodes.map((n) => n.id)).not.toContain(ids.a2);
  });
});

describe('graph_approaches', () => {
  it('returns the tree with statuses and the reason from the closing edge', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'measured X = -0.4 on 3 events', 'R1');

    const res = await call('graph_approaches', { claim: ids.claim });
    const claim = res.claim as { status: string };
    expect(claim.status).toBe('open');

    const counts = res.counts as { approaches: number; open: number };
    expect(counts.approaches).toBe(2);
    expect(counts.open).toBe(1);

    const tree = res.tree as Array<{
      id: string;
      depth: number;
      via: string;
      status: string;
      closedBy?: { why: string };
    }>;
    const first = tree.find((t) => t.id === ids.a1);
    const second = tree.find((t) => t.id === ids.a2);
    expect(first?.depth).toBe(1);
    expect(first?.via).toBe('implements');
    expect(first?.status).toBe('refuted');
    expect(first?.closedBy?.why).toBe('measured X = -0.4 on 3 events');
    expect(second?.depth).toBe(2);
    expect(second?.via).toBe('learned_from');
    expect(second?.status).toBe('open');
  });

  it('resolves a claim by the stable id leading its title', async () => {
    const ids = await seedTwoLayers();
    const res = await call('graph_approaches', { claim: 'H99' });
    const claim = res.claim as { id: string };
    expect(claim.id).toBe(ids.claim);
  });

  it('returns an empty tree, not an error, where no second layer exists', async () => {
    const ids = await seedTwoLayers();
    const res = await call('graph_approaches', { claim: ids.ctx });
    expect(res.tree).toEqual([]);
    const counts = res.counts as { approaches: number };
    expect(counts.approaches).toBe(0);
  });
});

describe('graph_frontier', () => {
  it('is empty and harmless on a graph with no layers', async () => {
    const res = await call('graph_frontier', {});
    const counts = res.counts as Record<string, number>;
    expect(counts.openClaims).toBe(0);
    expect(counts.openApproaches).toBe(0);
  });

  it('attributes a nested approach to the claim at the root of its chain', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'exhausted', 'R1');

    const res = await call('graph_frontier', {});
    const counts = res.counts as Record<string, number>;
    expect(counts.openClaims).toBe(1);
    expect(counts.openApproaches).toBe(1);
    expect(counts.openApproachesWithNoClaim).toBe(0);
    expect(counts.claimsWithNoOpenApproach).toBe(0);

    const open = res.openApproaches as Array<{
      id: string;
      claim: { id: string } | null;
    }>;
    expect(open[0].id).toBe(ids.a2);
    expect(open[0].claim?.id).toBe(ids.claim);
  });

  it('flags open approaches left under an already-closed claim', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'exhausted', 'R1');
    await invalidate(ids.claim, 'the idea is dead', 'R2');

    const res = await call('graph_frontier', {});
    const counts = res.counts as Record<string, number>;
    expect(counts.openClaims).toBe(0);
    expect(counts.openApproachesUnderClosedClaims).toBe(1);
  });
});

describe('premature invalidation warning', () => {
  it('warns when a CLAIM is invalidated while approaches are open', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'exhausted', 'R1');

    const res = await invalidate(ids.claim, 'approach one failed', 'R2');

    expect(res.success).toBe(true); // a warning, never a refusal
    const warnings = res.layerWarnings as Array<{
      claimId: string;
      openApproaches: Array<{ id: string }>;
      message: string;
    }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0].claimId).toBe(ids.claim);
    expect(warnings[0].openApproaches.map((a) => a.id)).toEqual([ids.a2]);
    expect(String(res.hint)).toContain(
      'CLAIM INVALIDATED WITH OPEN APPROACHES',
    );
  });

  it('stays silent when an APPROACH is invalidated', async () => {
    const ids = await seedTwoLayers();
    const res = await invalidate(ids.a1, 'exhausted', 'R1');
    expect(res.layerWarnings).toBeUndefined();
  });

  it('stays silent when the claim has no open approach left', async () => {
    const ids = await seedTwoLayers();
    await invalidate(ids.a1, 'exhausted', 'R1');
    await invalidate(ids.a2, 'also exhausted', 'R1b');

    const res = await invalidate(ids.claim, 'every way failed', 'R2');
    expect(res.layerWarnings).toBeUndefined();
  });
});
