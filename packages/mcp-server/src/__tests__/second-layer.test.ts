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

// ---------------------------------------------------------------------------
// Nodes that carry a stable identifier but belong to NEITHER layer.
// ---------------------------------------------------------------------------

/**
 * Three lines, written the way the corpus actually contains them (the
 * canonical "·" separator, which is what parseStableId recognises):
 *
 *   H60 — a live claim, with an `analysis` note beside it (harmless commentary)
 *   H61 — nothing but an `analysis` note: the line is DARK
 *   H63 — a refuted claim, with an `analysis` re-opening beside it: also DARK
 */
async function seedUnlayered() {
  const batch = (await call('graph_batch', {
    commit_message: 'seed: records that fall outside both layers',
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
          title: 'H60 · a claim still open',
          trigger: 'prediction',
          why: 'layer 1',
          understanding: 'The effect is real.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H60 · commentary beside a live claim',
          trigger: 'analysis',
          why: 'observation',
          understanding: 'Worth noting while H60 is still open.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H61 · this claim was never actually tested',
          trigger: 'analysis',
          why: 'observation',
          understanding: 'Nothing under H61 ever ran.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H63 · a claim that got refuted',
          trigger: 'prediction',
          why: 'layer 1',
          understanding: 'Turned out false.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H63 · re-opened, with a reason',
          trigger: 'analysis',
          why: 'observation',
          understanding: 'The refutation only covered one regime.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H60/1 · a way to test H60',
          trigger: 'experiment',
          why: 'layer 2',
          understanding: 'Measure it directly.',
          skipDuplicateCheck: true,
        },
      },
      ...[1, 2, 3, 4, 5].map((i) => ({
        tool: 'graph_connect',
        params: {
          from: `$${i}.id`,
          to: '$0.id',
          relation: 'sits in',
          type: 'relates',
          why: 'anchor',
        },
      })),
      {
        tool: 'graph_connect',
        params: {
          from: '$6.id',
          to: '$1.id',
          relation: 'is a way to test',
          type: 'implements',
          why: 'first way of establishing H60',
        },
      },
    ],
  })) as Res;

  const r = batch.results as Array<{ id: string }>;
  return {
    ctx: r[0].id,
    liveClaim60: r[1].id,
    note60: r[2].id,
    note61: r[3].id,
    claim63: r[4].id,
    note63: r[5].id,
    approach60: r[6].id,
  };
}

describe('graph_frontier · nodes outside both layers', () => {
  it('reports them, sorted by H number, with the dark lines flagged', async () => {
    const ids = await seedUnlayered();
    await invalidate(ids.claim63, 'measured the opposite', 'R63');

    const res = await call('graph_frontier', {});
    const counts = res.counts as Record<string, number>;
    expect(counts.unlayered).toBe(3);

    const unlayered = res.unlayered as Array<{
      id: string;
      trigger: string;
      stableId: string;
      lineIsDark: boolean;
    }>;
    expect(unlayered.map((u) => u.stableId)).toEqual(['H60', 'H61', 'H63']);
    expect(unlayered.map((u) => u.id)).toEqual([
      ids.note60,
      ids.note61,
      ids.note63,
    ]);
    expect(unlayered.every((u) => u.trigger === 'analysis')).toBe(true);

    // H60 sits beside a claim that is open and visible — not a dark line.
    expect(unlayered[0].lineIsDark).toBe(false);
    // H61 has nothing else at all; H63's only claim is refuted.
    expect(unlayered[1].lineIsDark).toBe(true);
    expect(unlayered[2].lineIsDark).toBe(true);
    expect(res.darkLines).toEqual(['H61', 'H63']);
    expect(counts.darkLines).toBe(2);
    expect(String(res.hint)).toContain('H61, H63');
  });

  it('leaves the layer nodes themselves out of it', async () => {
    const ids = await seedUnlayered();
    const res = await call('graph_frontier', {});
    const listed = (res.unlayered as Array<{ id: string }>).map((u) => u.id);
    // Layer 1: a canonically titled claim is not "unlayered"...
    expect(listed).not.toContain(ids.liveClaim60);
    expect(listed).not.toContain(ids.claim63);
    // ...and neither is a layer-2 approach (trigger experiment).
    expect(listed).not.toContain(ids.approach60);
    // The claim is where it belongs, so this is a classification test and not
    // an artefact of the node being filtered out somewhere else.
    const openClaims = res.openClaims as Array<{ id: string }>;
    expect(openClaims.map((c) => c.id)).toContain(ids.liveClaim60);
    const openApproaches = res.openApproaches as Array<{ id: string }>;
    expect(openApproaches.map((a) => a.id)).toContain(ids.approach60);
  });

  it('drops an out-of-layer node once it is closed', async () => {
    const ids = await seedUnlayered();
    await invalidate(ids.note61, 'checked: it WAS tested', 'R61');

    const res = await call('graph_frontier', {});
    const listed = (res.unlayered as Array<{ id: string }>).map((u) => u.id);
    expect(listed).not.toContain(ids.note61);
    expect((res.counts as Record<string, number>).unlayered).toBe(2);
  });

  it('is absent on a corpus with no layers at all', async () => {
    const res = await call('graph_frontier', {});
    const counts = res.counts as Record<string, number>;
    expect(counts.unlayered).toBe(0);
    expect(counts.darkLines).toBe(0);
    expect(res.unlayered).toEqual([]);
    expect(String(res.hint)).not.toContain('unlayered');
  });
});

// ---------------------------------------------------------------------------
// graph_revise can correct a trigger — the repair for the above.
// ---------------------------------------------------------------------------

describe('graph_revise · trigger correction', () => {
  it('changes nothing about the trigger when the parameter is absent', async () => {
    const ids = await seedUnlayered();
    const res = await call('graph_revise', {
      node: ids.note61,
      why: 'sharpening the wording',
      understanding: 'Nothing under H61 ever ran, checked twice.',
    });
    expect(res.success).toBe(true);
    expect(res.oldTrigger).toBeUndefined();
    expect(res.newTrigger).toBeUndefined();

    const revs = (await call('node_get_revisions', {
      nodeId: ids.note61,
    })) as Res;
    expect((revs.currentState as { trigger: string }).trigger).toBe('analysis');
  });

  it('rewrites the trigger and keeps the old one in the revision history', async () => {
    const ids = await seedUnlayered();
    const res = await call('graph_revise', {
      node: ids.note61,
      why: 'this is a claim, not a note about one',
      trigger: 'prediction',
    });
    expect(res.success).toBe(true);
    expect(res.oldTrigger).toBe('analysis');
    expect(res.newTrigger).toBe('prediction');

    const revs = (await call('node_get_revisions', {
      nodeId: ids.note61,
    })) as Res;
    expect((revs.currentState as { trigger: string }).trigger).toBe(
      'prediction',
    );
    const revisions = revs.revisions as Array<{
      revisionWhy: string;
      changes: { trigger: string };
    }>;
    const last = revisions[revisions.length - 1];
    expect(last.changes.trigger).toBe('analysis'); // the value it replaced
    expect(last.revisionWhy).toContain('this is a claim, not a note about one');
    expect(last.revisionWhy).toContain('[Trigger] analysis → prediction');

    // ...and the line is in the queue now instead of being dark.
    const frontier = await call('graph_frontier', {});
    const openClaims = frontier.openClaims as Array<{ id: string }>;
    expect(openClaims.map((c) => c.id)).toContain(ids.note61);
    const listed = (frontier.unlayered as Array<{ id: string }>).map(
      (u) => u.id,
    );
    expect(listed).not.toContain(ids.note61);
  });

  it('refuses a trigger that is not in the creation vocabulary', async () => {
    const ids = await seedUnlayered();
    const res = await call('graph_revise', {
      node: ids.note61,
      why: 'typo',
      trigger: 'predicton',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('INVALID_TRIGGER');
    expect(String(res.message)).toContain('prediction');

    const revs = (await call('node_get_revisions', {
      nodeId: ids.note61,
    })) as Res;
    expect((revs.currentState as { trigger: string }).trigger).toBe('analysis');
    expect(revs.currentVersion).toBe(1);
  });

  it('travels through graph_batch', async () => {
    const ids = await seedUnlayered();
    const batch = (await call('graph_batch', {
      commit_message: 'repair: H61 was a claim all along',
      ignoreWarnings: true,
      operations: [
        {
          tool: 'graph_revise',
          params: {
            node: ids.note61,
            why: 'reclassified while auditing the frontier',
            trigger: 'question',
          },
        },
      ],
    })) as Res;
    expect(batch.success).toBe(true);

    const revs = (await call('node_get_revisions', {
      nodeId: ids.note61,
    })) as Res;
    expect((revs.currentState as { trigger: string }).trigger).toBe('question');
  });
});

// ---------------------------------------------------------------------------
// The corpus does NOT obey the canonical separator. Every spelling below was
// taken from a real dark line; if the matcher ever narrows back to "H12 · ",
// these are the records that go silent again.
// ---------------------------------------------------------------------------

async function seedSpellings() {
  const concepts: Array<[string, string]> = [
    ['H70 НИКОГДА НЕ БЫЛА ПРОВЕРЕНА: ворота закрыл другой цикл', 'analysis'],
    ['H71 · ПЕРЕСПЕЦИФИЦИРОВАН: атрибуция hold остаётся', 'surprise'],
    ['H72-ПОПРАВКА · из четырёх заявленных потребителей', 'analysis'],
    ["H73's closure is attribution-bookkeeping only", 'evaluation'],
    ['H74/2 РАСШИРЕН (цикл 15, кандидат lot230)', 'analysis'],
    ['H75-Б продолжение той же линии', 'analysis'],
    // A claim written outside the canon too: it still keeps its line alive.
    ['H76 ЗАЯВКА, записанная без разделителя', 'prediction'],
    ['H76 комментарий рядом с живой заявкой', 'analysis'],
    // Must NOT parse as an identifier: a letter glued to the digits.
    ['H2O buffer notes', 'foundation'],
    ['H1B visa analogy', 'foundation'],
  ];

  const batch = (await call('graph_batch', {
    commit_message: 'seed: every spelling a stable id occurs in',
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
      ...concepts.map(([title, trigger]) => ({
        tool: 'graph_add_concept',
        params: {
          title,
          trigger,
          why: 'seed',
          understanding: `record: ${title}`,
          skipDuplicateCheck: true,
        },
      })),
      ...concepts.map((_, i) => ({
        tool: 'graph_connect',
        params: {
          from: `$${i + 1}.id`,
          to: '$0.id',
          relation: 'sits in',
          type: 'relates',
          why: 'anchor',
        },
      })),
    ],
  })) as Res;

  const r = batch.results as Array<{ id: string }>;
  return {
    ctx: r[0].id,
    space: r[1].id,
    dot: r[2].id,
    hyphenDot: r[3].id,
    apostrophe: r[4].id,
    approachLevel: r[5].id,
    letterSuffix: r[6].id,
    liveClaim76: r[7].id,
    note76: r[8].id,
    h2o: r[9].id,
    h1b: r[10].id,
  };
}

describe('graph_frontier · the stable id is written in many hands', () => {
  it('catches every spelling the corpus actually uses', async () => {
    const ids = await seedSpellings();
    const res = await call('graph_frontier', {});

    const unlayered = res.unlayered as Array<{
      id: string;
      stableId: string;
      lineIsDark: boolean;
    }>;
    expect(unlayered.map((u) => u.stableId)).toEqual([
      'H70', // "H70 НИКОГДА …"      — plain space
      'H71', // "H71 · ПЕРЕСПЕЦ…"    — the canonical dot
      'H72', // "H72-ПОПРАВКА · …"   — hyphen before the dot
      'H73', // "H73's closure …"    — apostrophe
      'H74/2', // "H74/2 РАСШИРЕН …" — approach-level, space
      'H75', // "H75-Б продолжение"  — letter after a hyphen
      'H76', // the note beside a live claim
    ]);
    const byId = new Map(unlayered.map((u) => [u.id, u]));
    expect(byId.get(ids.space)?.stableId).toBe('H70');
    expect(byId.get(ids.hyphenDot)?.stableId).toBe('H72');
    expect(byId.get(ids.apostrophe)?.stableId).toBe('H73');
    expect(byId.get(ids.approachLevel)?.stableId).toBe('H74/2');
    expect(byId.get(ids.letterSuffix)?.stableId).toBe('H75');
  });

  it('does not invent identifiers out of H2O and H1B', async () => {
    const ids = await seedSpellings();
    const res = await call('graph_frontier', {});
    const listed = (res.unlayered as Array<{ id: string }>).map((u) => u.id);
    expect(listed).not.toContain(ids.h2o);
    expect(listed).not.toContain(ids.h1b);
  });

  it('reads liveness with the same wide matcher as the report', async () => {
    const ids = await seedSpellings();
    const res = await call('graph_frontier', {});
    const unlayered = res.unlayered as Array<{
      id: string;
      lineIsDark: boolean;
    }>;
    const byId = new Map(unlayered.map((u) => [u.id, u]));

    // H76's claim is titled "H76 ЗАЯВКА …" — no canonical separator either.
    // The strict parser would not see it, and the note beside it would be
    // reported as a dark line that is not dark.
    expect(byId.get(ids.note76)?.lineIsDark).toBe(false);
    expect(
      (res.openClaims as Array<{ id: string }>).map((c) => c.id),
    ).toContain(ids.liveClaim76);

    // Everything else here has no live layer node on its number.
    expect(res.darkLines).toEqual(['H70', 'H71', 'H72', 'H73', 'H74', 'H75']);
    expect((res.counts as Record<string, number>).darkLines).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Tools that were declared, implemented — and never routed.
// ---------------------------------------------------------------------------

describe('concept tools reachable through handleToolCall', () => {
  it('node_set_trigger arrives and reclassifies the node', async () => {
    const ids = await seedUnlayered();
    const res = await call('node_set_trigger', {
      node: ids.note61,
      trigger: 'prediction',
    });
    expect(res.success).toBe(true);
    expect(res.oldTrigger).toBe('analysis');
    expect(res.newTrigger).toBe('prediction');

    const revs = (await call('node_get_revisions', {
      nodeId: ids.note61,
    })) as Res;
    expect((revs.currentState as { trigger: string }).trigger).toBe(
      'prediction',
    );
    const revisions = revs.revisions as Array<{ revisionWhy: string }>;
    expect(revisions[revisions.length - 1].revisionWhy).toContain(
      'Changed trigger from analysis to prediction',
    );
  });

  it('graph_archive arrives, hides the node, and preserves it', async () => {
    const ids = await seedUnlayered();
    const before = await call('graph_frontier', {});
    expect((before.counts as Record<string, number>).unlayered).toBe(3);

    const res = await call('graph_archive', {
      node: ids.note61,
      reason: 'folded into H61 itself',
    });
    expect(res.success).toBe(true);
    expect(res.id).toBe(ids.note61);

    // Hidden from every default query...
    const after = await call('graph_frontier', {});
    expect((after.counts as Record<string, number>).unlayered).toBe(2);
    expect(
      (after.unlayered as Array<{ id: string }>).map((u) => u.id),
    ).not.toContain(ids.note61);

    // ...but still there, exactly as the tool description promises.
    const revs = (await call('node_get_revisions', {
      nodeId: ids.note61,
    })) as Res;
    expect(revs.nodeId).toBe(ids.note61);
  });
});

// ---------------------------------------------------------------------------
// graph_rename edits the ADDRESS SPACE.
//
// In a corpus where "H34 · …" IS the address a later cycle resolves by name,
// rename is the one tool that can move an address, delete one, or point a
// second node at an address already in use — and the batch allocator that
// issues numbers never sees a rename, because a rename is not a new node.
//
// Two of the three holes are now closed: the call REPORTS what it did to the
// address space (`addressChange` / `addressWarning`), and the previous title
// survives in `revisions`. The third is deliberately open: nothing is
// REFUSED. Whether a taken identifier may be re-used is corpus policy — it
// would need a `force`, an exception for `supersedes`, and a decision about
// what writers are allowed to do — so it is the owner's call, not a defect
// fix. These tests pin exactly that split: mutation always goes through, the
// warning always names what happened.
// ---------------------------------------------------------------------------

async function seedTwoCanonicalClaims() {
  const batch = (await call('graph_batch', {
    commit_message: 'seed: two claims with canonical identifiers',
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
          title: 'H80 · the first claim',
          trigger: 'prediction',
          why: 'layer 1',
          understanding: 'A holds.',
          skipDuplicateCheck: true,
        },
      },
      {
        tool: 'graph_add_concept',
        params: {
          title: 'H81 · the second, unrelated claim',
          trigger: 'prediction',
          why: 'layer 1',
          understanding: 'B holds.',
          skipDuplicateCheck: true,
        },
      },
      ...[1, 2].map((i) => ({
        tool: 'graph_connect',
        params: {
          from: `$${i}.id`,
          to: '$0.id',
          relation: 'sits in',
          type: 'relates',
          why: 'anchor',
        },
      })),
    ],
  })) as Res;
  const r = batch.results as Array<{ id: string }>;
  return { ctx: r[0].id, h80: r[1].id, h81: r[2].id };
}

describe('graph_rename edits the address space', () => {
  it('arrives through handleToolCall and renames the node', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_rename', {
      node: ids.h81,
      newName: 'H81 · the second claim, reworded',
    });
    expect(res.success).toBe(true);
    expect(res.oldName).toBe('H81 · the second, unrelated claim');
    expect(res.newName).toBe('H81 · the second claim, reworded');
    // The identifier did not move, so there is nothing to warn about.
    expect(res.addressChange).toMatchObject({
      stableIdBefore: 'H81',
      stableIdAfter: 'H81',
      change: 'kept',
    });
    expect(res.addressWarning).toBeUndefined();

    const frontier = await call('graph_frontier', {});
    const open = frontier.openClaims as Array<{ id: string; name: string }>;
    expect(open.find((c) => c.id === ids.h81)?.name).toBe(
      'H81 · the second claim, reworded',
    );
  });

  // THE RULE: an identifier a live node wears can only be taken by the same
  // batch that supersedes that node. These four tests are the rule from all
  // four sides — bare call, batch without the edge, batch with it, and the
  // same batch with the edge target written as a back-reference.
  it('REFUSES a bare rename onto an identifier a live claim wears', async () => {
    const ids = await seedTwoCanonicalClaims();

    const res = await call('graph_rename', {
      node: ids.h81,
      newName: 'H80 · the second claim, now wearing H80',
      why: 'testing what the engine says about it',
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('IDENTIFIER_IN_USE');
    expect(res.stableId).toBe('H80');
    // The refusal names the holder — id and title — and the way forward.
    expect((res.ownedBy as Array<{ id: string }>).map((n) => n.id)).toEqual([
      ids.h80,
    ]);
    const message = String(res.message);
    expect(message).toContain(ids.h80);
    expect(message).toContain('H80 · the first claim');
    expect(message).toContain('supersedes');
    expect(message).toContain('graph_next_id');

    // Nothing moved: no write, no revision, no collision, and H80 still
    // resolves to exactly one node.
    const revs = (await call('node_get_revisions', {
      nodeId: ids.h81,
    })) as Res;
    expect(revs.currentVersion).toBe(1);
    const frontier = await call('graph_frontier', {});
    expect(
      (frontier.counts as Record<string, number>).collidingIdentifiers,
    ).toBe(0);
    const resolvable = await call('graph_approaches', { claim: 'H80' });
    expect((resolvable.claim as { id: string }).id).toBe(ids.h80);
  });

  it('refuses the same capture inside a batch that draws no `supersedes`', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_batch', {
      commit_message: 'take H80 without superseding it',
      ignoreWarnings: true,
      operations: [
        {
          tool: 'graph_rename',
          params: { node: ids.h81, newName: 'H80 · taken by a batch' },
        },
        {
          tool: 'graph_connect',
          params: {
            from: ids.h81,
            to: ids.h80,
            type: 'relates',
            why: 'a `relates` edge is not a supersession',
          },
        },
      ],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('IDENTIFIER_IN_USE');
    expect(res.operationIndex).toBe(0);
    expect(String(res.message)).toContain(ids.h80);

    // Refused BEFORE the transaction opened: not even the edge was written.
    const revs = (await call('node_get_revisions', {
      nodeId: ids.h81,
    })) as Res;
    expect(revs.currentVersion).toBe(1);
    const context = (await call('graph_context', { node: ids.h81 })) as Res;
    expect(JSON.stringify(context)).not.toContain('a `relates` edge is not');
  });

  it('lets the capture through when the same batch supersedes the holder — even with the edge written after the rename', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_batch', {
      commit_message: 're-specify H80; H81 takes the address it hands on',
      ignoreWarnings: true,
      operations: [
        // The rename executes FIRST: at this point the edge below does not
        // exist in the graph yet, which is exactly why the check reads the
        // operation list rather than the graph.
        {
          tool: 'graph_rename',
          params: {
            node: ids.h81,
            newName: 'H80 · the re-specification',
            why: 're-specification of H80',
          },
        },
        {
          tool: 'graph_connect',
          params: {
            from: '$0.id',
            to: ids.h80,
            type: 'supersedes',
            why: 'the re-specification replaces the original H80',
          },
        },
      ],
    });
    expect(res.success).toBe(true);
    const renamed = (res.results as Res[])[0];
    expect(renamed.success).toBe(true);
    expect(renamed.newName).toBe('H80 · the re-specification');
    // The report says the address was handed on, not contested.
    expect(String(renamed.addressWarning)).toContain('RE-SPECIFICATION');
    expect(String(renamed.addressWarning)).not.toContain('ALREADY IN USE');

    // One live claim answers to H80, and it is the new one.
    const frontier = await call('graph_frontier', {});
    expect(
      (frontier.counts as Record<string, number>).collidingIdentifiers,
    ).toBe(0);
    const resolved = await call('graph_approaches', { claim: 'H80' });
    expect((resolved.claim as { id: string }).id).toBe(ids.h81);
  });

  it('resolves a "$N.id" edge target, so a legitimate batch is not refused for writing one', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_batch', {
      commit_message: 're-specify H80, edge target written as "$0.id"',
      ignoreWarnings: true,
      operations: [
        // op0 acts on the HOLDER, so "$0.id" is the holder's id — knowable
        // before the batch runs, and the guard has to know it.
        {
          tool: 'graph_revise',
          params: {
            node: ids.h80,
            understanding: 'H80 as first stated, kept for the record.',
            why: 'note the incumbent before it is superseded',
          },
        },
        {
          tool: 'graph_rename',
          params: {
            node: ids.h81,
            newName: 'H80 · the re-specification, by reference',
            why: 're-specification of H80',
          },
        },
        {
          tool: 'graph_connect',
          params: {
            from: '$1.id',
            to: '$0.id',
            type: 'supersedes',
            why: 'the re-specification replaces the original H80',
          },
        },
      ],
    });
    expect(res.success).toBe(true);
    const frontier = await call('graph_frontier', {});
    expect(
      (frontier.counts as Record<string, number>).collidingIdentifiers,
    ).toBe(0);
    const resolved = await call('graph_approaches', { claim: 'H80' });
    expect((resolved.claim as { id: string }).id).toBe(ids.h81);
  });

  it('does not count a SUPERSEDED node as the holder of its identifier', async () => {
    const ids = await seedTwoCanonicalClaims();
    // H80 hands its identifier on to a node that does not carry one, so
    // nothing live wears H80 any more.
    const handOff = (await call('graph_batch', {
      commit_message:
        'H80 is replaced by a claim written without an identifier',
      ignoreWarnings: true,
      operations: [
        {
          tool: 'graph_add_concept',
          params: {
            title: 'the replacement for the first claim',
            trigger: 'prediction',
            why: 'layer 1',
            understanding: 'A holds, restated.',
            skipDuplicateCheck: true,
          },
        },
        {
          tool: 'graph_connect',
          params: {
            from: '$0.id',
            to: ids.h80,
            type: 'supersedes',
            why: 'replaces the first claim',
          },
        },
      ],
    })) as Res;
    expect(handOff.success).toBe(true);

    // ...so taking H80 is not a capture, and needs no edge of its own.
    const res = await call('graph_rename', {
      node: ids.h81,
      newName: 'H80 · picked up an address nobody live was using',
    });
    expect(res.success).toBe(true);
    expect(res.addressChange).toMatchObject({
      stableIdBefore: 'H81',
      stableIdAfter: 'H80',
      change: 'reassigned',
    });
  });

  it('leaves a rename onto a FREE identifier alone', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_rename', {
      node: ids.h81,
      newName: 'H82 · the second claim, renumbered by hand',
      why: 'H81 was a duplicate of an older number',
    });
    expect(res.success).toBe(true);
    expect(res.addressChange).toMatchObject({
      stableIdBefore: 'H81',
      stableIdAfter: 'H82',
      change: 'reassigned',
    });
    // Moving an address is still reported — it is only taking a TAKEN one
    // that is refused.
    expect(String(res.addressWarning)).toContain('ADDRESS MOVED');
    const resolved = await call('graph_approaches', { claim: 'H82' });
    expect((resolved.claim as { id: string }).id).toBe(ids.h81);
  });

  it('says so when the rename drops the identifier altogether', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_rename', {
      node: ids.h80,
      newName: 'the first claim, identifier dropped',
    });
    expect(res.success).toBe(true);
    expect(res.addressChange).toMatchObject({
      stableIdBefore: 'H80',
      stableIdAfter: null,
      change: 'dropped',
    });
    expect(String(res.addressWarning)).toContain('IDENTIFIER DROPPED');
    expect(String(res.addressWarning)).toContain('H80');

    // The node is still open and still on the frontier — only unreachable by
    // the name every earlier cycle used to refer to it.
    const frontier = await call('graph_frontier', {});
    expect(
      (frontier.openClaims as Array<{ id: string }>).map((c) => c.id),
    ).toContain(ids.h80);

    const lost = await call('graph_approaches', { claim: 'H80' });
    expect(lost.success).toBe(false);
    expect(lost.ambiguous).toBe(false); // not ambiguous — simply gone
  });

  it('keeps the previous title — the previous ADDRESS — in the revisions', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_rename', {
      node: ids.h80,
      newName: 'H80-Б · re-lettered',
      why: 'H80 was split, this half keeps the letter',
    });
    expect(res.success).toBe(true);
    expect(res.version).toBe(2);

    const revs = (await call('node_get_revisions', {
      nodeId: ids.h80,
    })) as Res;
    expect(revs.currentVersion).toBe(2);
    expect(revs.revisionCount).toBe(1);
    expect((revs.currentState as { text: string }).text).toBe(
      'H80-Б · re-lettered',
    );
    const revisions = revs.revisions as Array<{
      revisionWhy: string;
      changes: { text: string };
    }>;
    // The address someone else's prose still points at is readable from the
    // node itself, not only from the event log.
    expect(revisions[0].changes.text).toBe('H80 · the first claim');
    expect(revisions[0].revisionWhy).toBe(
      'H80 was split, this half keeps the letter',
    );
  });

  it('falls back to a self-describing revision reason when `why` is omitted', async () => {
    const ids = await seedTwoCanonicalClaims();
    await call('graph_rename', {
      node: ids.h80,
      newName: 'H80 · the first claim, reworded',
    });
    const revs = (await call('node_get_revisions', {
      nodeId: ids.h80,
    })) as Res;
    const revisions = revs.revisions as Array<{ revisionWhy: string }>;
    expect(revisions[0].revisionWhy).toContain('Renamed from');
    expect(revisions[0].revisionWhy).toContain('H80 · the first claim');
  });

  it('refuses an empty new name instead of silently keeping the old one', async () => {
    const ids = await seedTwoCanonicalClaims();
    const res = await call('graph_rename', { node: ids.h80, newName: '  ' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('MISSING_REQUIRED_FIELDS');

    const revs = (await call('node_get_revisions', {
      nodeId: ids.h80,
    })) as Res;
    expect(revs.currentVersion).toBe(1);
  });
});
