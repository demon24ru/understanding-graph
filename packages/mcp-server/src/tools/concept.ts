import {
  createCommit,
  getGraphStore,
  type TriggerType,
} from '@emergent-wisdom/understanding-graph-core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ContextManager } from '../context-manager.js';
import type { GraphIndex } from './layers.js';
import { isSuperseded, loadGraphIndex, looseStableId } from './layers.js';
import { describeAddressCapture, findAddressCapture } from './stable-ids.js';

/**
 * Every trigger a node may carry — the ONE list. Creation
 * (`graph_add_concept`) and correction (`graph_revise`) validate against it,
 * so a trigger that cannot be created can never be reached by revising either.
 */
const VALID_TRIGGERS: string[] = [
  'foundation',
  'surprise',
  'tension',
  'consequence',
  'repetition',
  'question',
  'serendipity',
  'decision',
  'experiment',
  'analysis',
  'randomness',
  'reference',
  'library',
  'prediction',
  'hypothesis',
  'model',
  'evaluation',
  'thinking', // Reserved for synthesizer only
];

/** What a writer may choose: `thinking` belongs to the synthesizer alone. */
const WRITABLE_TRIGGERS = VALID_TRIGGERS.filter((t) => t !== 'thinking');

// Similarity thresholds for duplicate detection
const SIMILARITY_THRESHOLDS = {
  DUPLICATE: 0.8, // > 0.8 = near duplicate, should extend not create
  CAUTION: 0.6, // 0.6-0.8 = related, warn but allow
  SAFE: 0.4, // < 0.6 = different enough
};

export const conceptTools: Tool[] = [
  {
    name: 'graph_add_concept',
    description: `Add a new concept node to the understanding graph.

AUTOMATIC DUPLICATE DETECTION:
This tool automatically checks for similar existing concepts before creating:
- >80% similarity: BLOCKS creation - extend existing concept instead
- 60-80% similarity: WARNS but creates - consider linking
- <60% similarity: Creates normally

If blocked, you'll receive the existing concept ID and suggestions for how to extend it instead.

WHEN TO USE:
- You have a genuinely new insight not already captured
- You've checked graph_semantic_search and found nothing similar
- You want to record an important idea for future reference

PARAMETERS:
- title: Title of the concept (REQUIRED)
- trigger: Why adding (foundation/surprise/tension/consequence/question/etc)
- understanding: Your synthesis of this concept
- why: Why this matters`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title/name of the concept',
        },
        trigger: {
          type: 'string',
          enum: [
            'foundation',
            'surprise',
            'tension',
            'consequence',
            'repetition',
            'question',
            'serendipity',
            'reference',
            'library',
            'prediction',
            'hypothesis',
            'model',
            'evaluation',
            'decision',
            'experiment',
            'analysis',
          ],
          description:
            'Why this concept is being added: foundation (core building block), surprise (unexpected), tension (creates conflict), consequence (has implications), repetition (frequently occurring), question (open question), serendipity (random synthesis), reference (pointer to another project/URL - REQUIRES references field), library (collection of references), prediction (forward-looking belief), hypothesis (explanatory theory), model (generalized pattern), evaluation (normative reflection), decision (a choice between alternatives with rationale), experiment (a test that will yield information), analysis (structured breakdown of an existing concept). Note: trigger "thinking" is reserved for the synthesizer agent and is intentionally omitted here.',
        },
        references: {
          type: 'array',
          description:
            'REQUIRED for trigger="reference". Array of cross-project or URL references. Each item must have either {project, nodeId, title?} for cross-project refs OR {url, title?} for web refs.',
          items: {
            type: 'object',
            properties: {
              project: {
                type: 'string',
                description: 'Project ID for cross-project reference',
              },
              nodeId: {
                type: 'string',
                description: 'Node ID in the referenced project',
              },
              url: {
                type: 'string',
                description: 'URL for external web reference',
              },
              title: {
                type: 'string',
                description: 'Display title for the reference',
              },
            },
          },
        },
        why: {
          type: 'string',
          description: 'Why this concept matters or why you are adding it',
        },
        understanding: {
          type: 'string',
          description: 'Your synthesis/understanding of this concept',
        },
        project: {
          type: 'string',
          description:
            'Project ID (optional, uses current project if not specified)',
        },
        skipDuplicateCheck: {
          type: 'boolean',
          description:
            'Skip duplicate detection. Only use if you have already verified no similar concept exists via graph_semantic_search.',
        },
        agent_name: {
          type: 'string',
          description:
            'Name of the agent making this call. Auto-injected by the system.',
        },
      },
      required: ['title', 'trigger', 'why', 'understanding'],
    },
  },
  {
    name: 'graph_question',
    description:
      'Create a question node representing something you want to explore or understand better.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question you want to explore',
        },
        speculation: {
          type: 'string',
          description:
            'Your initial speculation or hypothesis about the answer',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'graph_revise',
    description: `Update concept understanding with EPISTEMIC JOURNEY tracking.

This tool captures HOW your understanding developed, not just WHAT changed.
The before/after/pivot fields create a learning trail for future agents.

EPISTEMIC JOURNEY (recommended for significant revisions):
- before: What you believed before ("I thought X because...")
- after: What you now believe ("Now I see Y because...")
- pivot: The key insight that caused the shift ("The realization was...")

These fields are stored in revision history, making understanding evolution visible.

TRIGGER CORRECTION (optional): pass "trigger" to reclassify the node in place —
a claim written as \`analysis\` never reaches the frontier, and superseding it
just to fix the classification inflates the corpus. The old trigger stays
visible in the revision history together with your \`why\`.

WARNING: use "node" (NOT "nodeId"). Updates "understanding" field - for prose use doc_revise instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description:
            'Node name or ID. WARNING: param is "node", NOT "nodeId" (doc_revise uses nodeId)',
        },
        understanding: {
          type: 'string',
          description:
            'Updated understanding text (this is NOT prose - use doc_revise for prose). Optional if only updating references.',
        },
        before: {
          type: 'string',
          description:
            'EPISTEMIC JOURNEY: What you believed before this revision. Example: "I thought caching was causing the slowdown"',
        },
        after: {
          type: 'string',
          description:
            'EPISTEMIC JOURNEY: What you now believe. Example: "Now I see the database query was the bottleneck"',
        },
        pivot: {
          type: 'string',
          description:
            'EPISTEMIC JOURNEY: The key insight or evidence that caused the shift. Example: "Profiling showed 80% time in SQL"',
        },
        trigger: {
          type: 'string',
          enum: WRITABLE_TRIGGERS,
          description:
            'OPTIONAL: correct the trigger of this node. Omit to leave the classification exactly as it is. Use it to repair a mis-classified node (e.g. a claim written as "analysis", which the two-layer frontier can never see) instead of superseding it with a near-duplicate. The previous trigger is kept in the revision history.',
        },
        references: {
          type: 'array',
          description:
            'Update cross-project or URL references. Each item must have either {project, nodeId, title?} for cross-project refs OR {url, title?} for web refs.',
          items: {
            type: 'object',
            properties: {
              project: {
                type: 'string',
                description: 'Project ID for cross-project reference',
              },
              nodeId: {
                type: 'string',
                description: 'Node ID in the referenced project',
              },
              url: {
                type: 'string',
                description: 'URL for external web reference',
              },
              title: {
                type: 'string',
                description: 'Display title for the reference',
              },
            },
          },
        },
        why: {
          type: 'string',
          description: 'Why you are revising this concept',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['node', 'why'],
    },
  },
  {
    name: 'graph_supersede',
    description:
      'Replace a wrong or incomplete concept with a fundamentally better understanding. Creates a supersession edge to preserve evolution history.',
    inputSchema: {
      type: 'object',
      properties: {
        old: {
          type: 'string',
          description: 'Node name or ID to supersede',
        },
        new_name: {
          type: 'string',
          description: 'Name for the replacement concept',
        },
        new_understanding: {
          type: 'string',
          description: 'The corrected understanding',
        },
        why: {
          type: 'string',
          description: 'Why the original was wrong or incomplete',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['old', 'new_name', 'new_understanding', 'why'],
    },
  },
  {
    name: 'graph_add_reference',
    description:
      'Add a reference to an existing node. Can be an external URL OR a cross-project reference to a node in another project.',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Node name or ID to add reference to',
        },
        url: {
          type: 'string',
          description: 'URL of the source (for external web references)',
        },
        title: {
          type: 'string',
          description: 'Title/description of the reference (optional)',
        },
        refProject: {
          type: 'string',
          description:
            'For cross-project refs: Project ID containing the referenced node',
        },
        refNodeId: {
          type: 'string',
          description:
            'For cross-project refs: Node ID in the referenced project',
        },
        project: {
          type: 'string',
          description: 'Current project ID (optional)',
        },
      },
      required: ['node'],
    },
  },
  {
    name: 'node_set_metadata',
    description:
      'Set arbitrary metadata on a node. Merges with existing metadata. Use for module-specific data (e.g., narrative-engine coordinates, thought_fluid translations). Creates a commit if commit_message is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Node name or ID',
        },
        metadata: {
          type: 'object',
          description: 'Metadata object to merge with existing metadata',
          additionalProperties: true,
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
        commit_message: {
          type: 'string',
          description:
            'REQUIRED: Your reflection on this metadata change. Explain your strategy, what you noticed, why this matters. NOT a description of the action.',
        },
        agent_name: {
          type: 'string',
          description:
            'Name of the agent making this change. Used for commit tracking.',
        },
        commit_timestamp: {
          type: 'string',
          description:
            'Optional ISO timestamp for retroactive commits. If not provided, uses current time.',
        },
      },
      required: ['node', 'metadata', 'commit_message'],
    },
  },
  {
    name: 'node_get_metadata',
    description: 'Get metadata from a node.',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Node name or ID',
        },
        key: {
          type: 'string',
          description:
            'Specific key to retrieve (optional, returns all if not specified)',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['node'],
    },
  },
  {
    name: 'graph_rename',
    description:
      'EDITS THE ADDRESS SPACE OF THE CORPUS — not the text of a node. Where titles carry a stable identifier ("H34 · …") the title IS the address: other agents reach that node by it (graph_approaches("H34"), references in prose, another cycle\'s notes), so moving it silently breaks everything pointing there. WHAT THIS IS NOT: not a way to fix a typo you just made yourself, not a way to tidy up wording (use graph_revise for understanding, and leave the title alone), and not a way around a refusal from the id allocator — numbers are issued by the engine at creation, and graph_next_id hands out a free one. THE ONE LEGITIMATE CASE: a re-specification that keeps the identifier, renamed in ONE graph_batch that also draws a `supersedes` edge at the node currently holding it. Taking a live node\'s identifier any other way is REFUSED (error IDENTIFIER_IN_USE, naming the holder). Renames that keep the identifier, drop it, or take a free one go through, and the result reports `addressChange` (kept / reassigned / dropped / acquired) plus an `addressWarning` when the move costs somebody a reference. The previous title is kept in the revision history.',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Node name or ID to rename',
        },
        newName: {
          type: 'string',
          description: 'The new name for the node',
        },
        why: {
          type: 'string',
          description:
            'Why the node is being renamed. Stored as the reason on the revision that keeps the previous title; defaults to "Renamed from X to Y".',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['node', 'newName'],
    },
  },
  {
    name: 'graph_archive',
    description:
      'REMOVES A NODE FROM EVERY QUERY (soft-delete): out of context, out of the frontier, out of search; the row survives in history, but nothing routine will surface it again. NEVER ARCHIVE SOMETHING FOR BEING WRONG. "We tried that and it did not work" is the most expensive knowledge in a corpus — it is what stops the next cycle repeating a dead approach — and archiving it is how that knowledge gets rediscovered the hard way. A refuted approach gets an `invalidates` edge; a superseded understanding gets `supersedes`; both keep the node visible with its verdict attached. Legitimate use is narrow: an accidental duplicate, a node created by mistake, debris that says nothing. If you are archiving to make the frontier look tidier, stop — the frontier is a work queue, and shortening it by hiding work is lying to whoever reads it next.',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Node name or ID to archive',
        },
        reason: {
          type: 'string',
          description: 'Why this node is being archived',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['node'],
    },
  },
  {
    name: 'node_set_trigger',
    description:
      'Correct a MIS-CLASSIFICATION: the node was always this kind of thing and was filed as another (foundation→analysis, analysis→tension). WHAT THIS IS NOT: a way to move a node into another layer after the fact. A finding honestly written as `analysis` does not become a claim because its trigger now says `prediction` — a claim has to name a mechanism AND the evidence that would refute it, and a trigger change writes neither. If an observation deserves to be attacked, WRITE THE CLAIM and connect it to the observation (`learned_from`); the observation stays what it was. This is not theory: eight lines of research in this corpus fell out of the work queue precisely because a re-opening was recorded as an observation, and every one of them needed a claim written, not a trigger changed. Nor is it a way to hide a node from a query — `graph_find_by_trigger` and `graph_frontier` read triggers, so re-labelling to keep something out of the frontier is falsifying the queue.',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Node name or ID',
        },
        trigger: {
          type: 'string',
          enum: [
            'foundation',
            'surprise',
            'tension',
            'consequence',
            'repetition',
            'question',
            'serendipity',
            'decision',
            'experiment',
            'analysis',
            'library',
            'prediction',
            'hypothesis',
            'model',
            'evaluation',
          ],
          description: 'New trigger type for the node',
        },
        project: {
          type: 'string',
          description: 'Project ID (optional)',
        },
      },
      required: ['node', 'trigger'],
    },
  },
];

export async function handleConceptTools(
  name: string,
  args: Record<string, unknown>,
  contextManager: ContextManager,
): Promise<unknown> {
  const projectId =
    (args.project as string) || contextManager.getCurrentProjectId();
  const conversationId =
    await contextManager.getCurrentConversationId(projectId);
  const toolCallId = contextManager.getCurrentToolCall();

  switch (name) {
    case 'graph_add_concept': {
      const store = getGraphStore();

      // Check for common parameter mistakes
      if (!args.title && (args.name || args.text)) {
        const used = args.name ? 'name' : 'text';
        return {
          success: false,
          error: 'INVALID_PARAMETER',
          message: `You used "${used}" but this tool requires "title" for the concept title.`,
          hint: `Please retry with title: "${args.name || args.text}"`,
        };
      }

      const conceptName = args.title as string;
      const understanding = args.understanding as string;
      const skipCheck = args.skipDuplicateCheck === true;
      const trigger = args.trigger as TriggerType;
      const why = args.why as string;
      const references = args.references as
        | Array<{
            project?: string;
            nodeId?: string;
            url?: string;
            title?: string;
          }>
        | undefined;

      // Validate required fields with clear error messages
      const missing: string[] = [];
      if (!conceptName) missing.push('title');
      if (!trigger) missing.push('trigger');
      if (!why) missing.push('why');
      if (!understanding) missing.push('understanding');

      if (missing.length > 0) {
        return {
          success: false,
          error: 'MISSING_REQUIRED_FIELDS',
          message: `graph_add_concept requires: ${missing.join(', ')}`,
          received: {
            title: conceptName || '(missing)',
            trigger: trigger || '(missing)',
            why: why || '(missing)',
            understanding: understanding ? '(provided)' : '(missing)',
          },
          hint: 'All concept nodes must have title, trigger, why, and understanding.',
        };
      }

      // Validate: reference trigger REQUIRES references field
      if (trigger === 'reference' && (!references || references.length === 0)) {
        return {
          success: false,
          error: 'MISSING_REFERENCES',
          message:
            'trigger="reference" requires the references field with at least one cross-project ref {project, nodeId} or URL ref {url}',
          hint: 'Example: references: [{ project: "thinking-protocol", nodeId: "n_abc123", title: "Paper Title" }]',
        };
      }

      // Validate reference structure
      if (references && references.length > 0) {
        for (const ref of references) {
          const hasCrossProject = ref.project && ref.nodeId;
          const hasUrl = ref.url;
          if (!hasCrossProject && !hasUrl) {
            return {
              success: false,
              error: 'INVALID_REFERENCE',
              message:
                'Each reference must have either {project, nodeId} for cross-project refs OR {url} for web refs',
              invalidRef: ref,
            };
          }
        }
      }

      // Validate trigger is a valid value
      if (!VALID_TRIGGERS.includes(trigger)) {
        return {
          success: false,
          error: 'INVALID_TRIGGER',
          message: `Invalid trigger "${trigger}". Valid triggers: ${WRITABLE_TRIGGERS.join(', ')}`,
          hint: 'Choose a trigger that describes why you are adding this concept.',
        };
      }

      // THINKING NODE RESTRICTION: Only synthesizer can create thinking nodes
      const agentName = args.agent_name as string | undefined;
      if (trigger === 'thinking' && agentName !== 'synthesizer') {
        return {
          success: false,
          error: 'FORBIDDEN_TRIGGER',
          message: `trigger "thinking" is reserved for the synthesizer agent only. Agent "${agentName || 'unknown'}" cannot create thinking nodes.`,
          hint: 'Use a different trigger (e.g., analysis, question, tension, insight).',
        };
      }

      // Duplicate detection (unless explicitly skipped)
      if (!skipCheck) {
        try {
          // Search for similar concepts using the combined name + understanding
          const searchText = `${conceptName}: ${understanding}`;
          const similar = await store.semanticSearch(searchText, 5);

          if (similar.length > 0) {
            const topMatch = similar[0];

            // DUPLICATE (>0.8): Block creation, suggest extending existing
            if (topMatch.similarity > SIMILARITY_THRESHOLDS.DUPLICATE) {
              return {
                success: false,
                blocked: true,
                reason: 'NEAR_DUPLICATE',
                message: `Found near-duplicate concept with ${Math.round(topMatch.similarity * 100)}% similarity. Extend or link to existing concept instead of creating new.`,
                existingConcept: {
                  id: topMatch.node.id,
                  name: topMatch.node.title,
                  similarity: Math.round(topMatch.similarity * 100) / 100,
                  understanding: topMatch.node.understanding?.slice(0, 300),
                },
                suggestions: [
                  `Use graph_revise to update "${topMatch.node.title}" (${topMatch.node.id})`,
                  `Use graph_connect to link your new insight to the existing concept`,
                  `Use graph_supersede if your understanding fundamentally replaces the old one`,
                  `Set skipDuplicateCheck=true if you are certain this is genuinely different`,
                ],
                otherSimilar: similar.slice(1, 3).map((s) => ({
                  id: s.node.id,
                  name: s.node.title,
                  similarity: Math.round(s.similarity * 100) / 100,
                })),
              };
            }

            // CAUTION (0.6-0.8): Warn but allow creation
            if (topMatch.similarity > SIMILARITY_THRESHOLDS.CAUTION) {
              // Create the node but include warning
              const node = store.createNode({
                title: conceptName,
                trigger,
                why: args.why as string,
                understanding,
                conversationId,
                toolCallId,
                references,
              });

              return {
                success: true,
                id: node.id,
                name: node.title,
                message: `Created concept "${node.title}" with ID: ${node.id}`,
                warning: {
                  level: 'CAUTION',
                  message: `Similar concept exists (${Math.round(topMatch.similarity * 100)}% similarity). Consider linking to it.`,
                  similarConcept: {
                    id: topMatch.node.id,
                    name: topMatch.node.title,
                    similarity: Math.round(topMatch.similarity * 100) / 100,
                  },
                  suggestion: `Consider: graph_connect from "${node.title}" to "${topMatch.node.title}"`,
                },
                hint: 'You can now connect it to other concepts using graph_connect',
              };
            }
          }
        } catch {
          // Semantic search failed (no embeddings?) - proceed without check
        }
      }

      // Create the node (no duplicates found or check skipped)
      const node = store.createNode({
        title: conceptName,
        trigger,
        why: args.why as string,
        understanding,
        conversationId,
        toolCallId,
        references,
      });

      return {
        success: true,
        id: node.id,
        name: node.title,
        message: `Created concept "${node.title}" with ID: ${node.id}`,
        hint: 'You can now connect it to other concepts using graph_connect',
      };
    }

    case 'graph_question': {
      const store = getGraphStore();
      const node = store.createNode({
        title: args.question as string,
        trigger: 'question',
        why: 'Open question to explore',
        understanding: (args.speculation as string) || '',
        conversationId,
        toolCallId,
      });

      return {
        success: true,
        id: node.id,
        question: node.title,
        message: `Created question node "${node.title}" with ID: ${node.id}`,
        hint: 'When you find the answer, use graph_answer to record it',
      };
    }

    case 'graph_revise': {
      // Check for common parameter mistakes
      if (!args.node && (args.nodeId || args.id)) {
        const used = args.nodeId ? 'nodeId' : 'id';
        return {
          success: false,
          error: 'INVALID_PARAMETER',
          message: `You used "${used}" but this tool requires "node" (name or ID).`,
          hint: `Please retry with node: "${args.nodeId || args.id}"`,
        };
      }

      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      const store = getGraphStore();

      // OPTIONAL trigger correction. Absent `trigger`, everything below behaves
      // exactly as it did before this parameter existed.
      const rawTrigger = args.trigger;
      let newTrigger: TriggerType | undefined;
      let oldTrigger: string | null = null;
      if (
        rawTrigger !== undefined &&
        rawTrigger !== null &&
        rawTrigger !== ''
      ) {
        if (
          typeof rawTrigger !== 'string' ||
          !VALID_TRIGGERS.includes(rawTrigger)
        ) {
          return {
            success: false,
            error: 'INVALID_TRIGGER',
            message: `Invalid trigger "${String(rawTrigger)}". Valid triggers: ${WRITABLE_TRIGGERS.join(', ')}`,
            hint: 'Omit `trigger` entirely to revise the understanding without touching the classification.',
          };
        }
        // Same restriction as creation: `thinking` is the synthesizer's alone,
        // and a revision must not become the way around it.
        if (
          rawTrigger === 'thinking' &&
          (args.agent_name as string | undefined) !== 'synthesizer'
        ) {
          return {
            success: false,
            error: 'FORBIDDEN_TRIGGER',
            message: `trigger "thinking" is reserved for the synthesizer agent only. Agent "${(args.agent_name as string) || 'unknown'}" cannot set it.`,
            hint: 'Choose one of: analysis, evaluation, tension, question, ...',
          };
        }
        newTrigger = rawTrigger as TriggerType;
        oldTrigger = store.getNode(resolved.id)?.trigger ?? null;
      }

      // Extract epistemic journey fields
      const before = args.before as string | undefined;
      const after = args.after as string | undefined;
      const pivot = args.pivot as string | undefined;

      // Build epistemic journey summary for revision history
      let epistemicJourney: string | undefined;
      if (before || after || pivot) {
        const parts: string[] = [];
        if (before) parts.push(`BEFORE: ${before}`);
        if (after) parts.push(`AFTER: ${after}`);
        if (pivot) parts.push(`PIVOT: ${pivot}`);
        epistemicJourney = parts.join(' | ');
      }

      // Build revision why - include epistemic journey if provided
      const baseWhy = args.why as string;
      const withJourney = epistemicJourney
        ? `${baseWhy}\n\n[Epistemic Journey]\n${epistemicJourney}`
        : baseWhy;
      // The reclassification is spelled out in the revision reason as well, so
      // node_get_revisions reads "why" and "from what to what" in one place.
      const fullRevisionWhy =
        newTrigger && newTrigger !== oldTrigger
          ? `${withJourney}\n\n[Trigger] ${oldTrigger ?? 'none'} → ${newTrigger}`
          : withJourney;

      // Build update payload - only include fields that were provided
      const updatePayload: {
        understanding?: string;
        trigger?: TriggerType;
        references?: Array<{
          project?: string;
          nodeId?: string;
          url?: string;
          title?: string;
        }>;
        revisionWhy: string;
        conversationId: string | undefined;
        epistemicJourney?: {
          before?: string;
          after?: string;
          pivot?: string;
        };
      } = {
        revisionWhy: fullRevisionWhy,
        conversationId,
      };

      if (args.understanding) {
        updatePayload.understanding = args.understanding as string;
      }
      if (newTrigger) {
        updatePayload.trigger = newTrigger;
      }
      if (args.references) {
        updatePayload.references = args.references as Array<{
          project?: string;
          nodeId?: string;
          url?: string;
          title?: string;
        }>;
      }

      // Store structured epistemic journey in metadata for programmatic access
      if (before || after || pivot) {
        updatePayload.epistemicJourney = {};
        if (before) updatePayload.epistemicJourney.before = before;
        if (after) updatePayload.epistemicJourney.after = after;
        if (pivot) updatePayload.epistemicJourney.pivot = pivot;
      }

      const node = store.updateNode(resolved.id, updatePayload);

      const response: Record<string, unknown> = {
        success: true,
        id: node.id,
        name: node.title,
        version: node.version,
        message: `Revised concept "${node.title}" (now version ${node.version})`,
      };

      if (newTrigger) {
        response.oldTrigger = oldTrigger;
        response.newTrigger = node.trigger;
        response.message = `Revised concept "${node.title}" (now version ${node.version}); trigger ${oldTrigger ?? 'none'} → ${node.trigger}`;
      }

      // Include epistemic journey in response if provided
      if (before || after || pivot) {
        response.epistemicJourney = {
          before,
          after,
          pivot,
        };
        response.hint =
          'Epistemic journey recorded in revision history. Use node_get_revisions to see how understanding evolved.';
      }

      return response;
    }

    case 'graph_supersede': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.old as string,
        projectId,
      );

      const store = getGraphStore();

      // Create new node
      const newNode = store.createNode({
        title: args.new_name as string,
        trigger: 'foundation',
        why: args.why as string,
        understanding: args.new_understanding as string,
        conversationId,
        toolCallId,
      });

      // Create supersession edge
      store.createEdge({
        fromId: newNode.id,
        toId: resolved.id,
        type: 'supersedes',
        why: args.why as string,
        conversationId,
        toolCallId,
      });

      // Archive the old node
      store.archiveNode(resolved.id, 'Superseded', conversationId);

      return {
        success: true,
        oldId: resolved.id,
        oldName: resolved.title,
        newId: newNode.id,
        newName: newNode.title,
        message: `Created "${newNode.title}" superseding "${resolved.title}"`,
        hint: 'The old concept is now hidden from default context but preserved in history',
      };
    }

    case 'graph_add_reference': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      // Build reference object - either URL-based or cross-project
      const refProject = args.refProject as string | undefined;
      const refNodeId = args.refNodeId as string | undefined;
      const url = args.url as string | undefined;

      if (!url && (!refProject || !refNodeId)) {
        throw new Error(
          'Either url OR (refProject + refNodeId) must be provided',
        );
      }

      const reference: {
        url?: string;
        title?: string;
        accessed?: string;
        project?: string;
        nodeId?: string;
      } = {
        title: args.title as string | undefined,
        accessed: new Date().toISOString(),
      };

      if (url) {
        reference.url = url;
      } else {
        reference.project = refProject;
        reference.nodeId = refNodeId;
      }

      const store = getGraphStore();
      const node = store.addReference(resolved.id, reference);

      if (!node) {
        throw new Error(`Failed to add reference to node: ${resolved.title}`);
      }

      const refCount = node.references?.length || 0;
      const refType = url
        ? 'URL reference'
        : `cross-project ref to ${refProject}:${refNodeId}`;
      return {
        success: true,
        id: node.id,
        name: node.title,
        referenceCount: refCount,
        message: `Added ${refType} to "${node.title}" (${refCount} total)`,
      };
    }

    case 'node_set_metadata': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      const store = getGraphStore();
      const metadata = args.metadata as Record<string, unknown>;
      const node = store.setMetadata(resolved.id, metadata);

      if (!node) {
        throw new Error(`Failed to set metadata on node: ${resolved.title}`);
      }

      // Create commit - required
      const commitMessage = args.commit_message as string;
      const agentName = args.agent_name as string | undefined;
      const commitTimestamp = args.commit_timestamp as string | undefined;

      if (!commitMessage) {
        return {
          success: false,
          error: 'MISSING_COMMIT_MESSAGE',
          message: 'commit_message is required. Reflect on your strategy.',
          hint: 'Explain what you noticed, why this metadata matters, what pattern emerged.',
        };
      }

      const createdCommit = createCommit(
        commitMessage,
        [node.id], // affected node
        [], // no edges
        agentName,
        commitTimestamp,
      );
      const commit = {
        id: createdCommit.id,
        message: createdCommit.message,
        createdAt: createdCommit.createdAt,
      };

      return {
        success: true,
        id: node.id,
        name: node.title,
        metadata: node.metadata,
        commit,
        message: commit
          ? `Updated metadata on "${node.title}". Commit: "${commit.message}"`
          : `Updated metadata on "${node.title}"`,
      };
    }

    case 'node_get_metadata': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      const store = getGraphStore();
      const key = args.key as string | undefined;

      if (key) {
        const value = store.getMetadataKey(resolved.id, key);
        return {
          success: true,
          id: resolved.id,
          name: resolved.title,
          key,
          value,
        };
      } else {
        const metadata = store.getMetadata(resolved.id);
        return {
          success: true,
          id: resolved.id,
          name: resolved.title,
          metadata,
        };
      }
    }

    case 'graph_rename': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      const store = getGraphStore();
      const oldName = resolved.title;
      const newName = args.newName as string;

      if (typeof newName !== 'string' || newName.trim() === '') {
        return {
          success: false,
          error: 'MISSING_REQUIRED_FIELDS',
          message: 'graph_rename requires a non-empty "newName".',
          hint: 'Pass the full new title, including its stable identifier if the node carries one.',
        };
      }

      // --- ADDRESS SPACE -------------------------------------------------
      // The title carries the stable identifier, and identifiers are resolved
      // BY TITLE (graph_approaches, resolveClaim). So a rename can move an
      // address, delete one, or point a second node at an address already in
      // use — and the batch allocator that issues numbers never sees a rename
      // (`titleFieldFor` returns null for it).
      //
      // ONE thing is refused, and only one: taking an identifier a live node
      // still wears, unless the same batch draws a `supersedes` edge at that
      // node. See `findAddressCapture` for why that is the allocator's own
      // policy rather than a new one, and for why the refusal uses the STRICT
      // parser while everything reported below uses the loose one.
      // Everything else — keeping an identifier, dropping one, taking a free
      // one — goes through and is reported, in the same shape the frontier
      // reports `collidingIdentifiers`.
      let index: GraphIndex | null = null;
      try {
        index = loadGraphIndex(projectId);
      } catch {
        // A diagnostic must never be the reason a rename fails; and if the
        // index cannot be read at all, the write below will fail anyway.
        index = null;
      }

      // How graph_batch tells this handler what the REST of the batch does:
      // the `supersedes` edge that legitimises a capture is a separate
      // operation and may well run AFTER this one, so it cannot be seen in the
      // graph from here. Absent — a bare graph_rename call — means "no batch,
      // no edge, nothing sanctions this", which is the right default.
      const supersedesInBatch = Array.isArray(args._supersedesInBatch)
        ? (args._supersedesInBatch as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : [];

      const idBefore = looseStableId(oldName);
      const idAfter = looseStableId(newName);
      const render = (
        p: { claimNum: number; approachNum: number | null } | null,
      ) =>
        p === null
          ? null
          : p.approachNum === null
            ? `H${p.claimNum}`
            : `H${p.claimNum}/${p.approachNum}`;
      const stableIdBefore = render(idBefore);
      const stableIdAfter = render(idAfter);

      const sharesIdentifierWith: Array<{
        id: string;
        title: string;
        trigger: string | null;
        createdAt: string;
      }> = [];
      if (stableIdAfter && index) {
        for (const n of index.nodes.values()) {
          if (n.id === resolved.id) continue;
          if (render(looseStableId(n.title)) !== stableIdAfter) continue;
          // A re-specification keeps the identifier on purpose; the node it
          // replaced is not a rival for the name.
          if (isSuperseded(n.id, index)) continue;
          sharesIdentifierWith.push({
            id: n.id,
            title:
              n.title.length > 160 ? `${n.title.slice(0, 157)}...` : n.title,
            trigger: n.trigger,
            createdAt: n.createdAt,
          });
        }
      }

      const change =
        stableIdBefore === stableIdAfter
          ? 'kept'
          : stableIdAfter === null
            ? 'dropped'
            : stableIdBefore === null
              ? 'acquired'
              : 'reassigned';

      const notes: string[] = [];
      if (change === 'reassigned') {
        notes.push(
          `⚠️ ADDRESS MOVED: this node answered to ${stableIdBefore} and now answers to ${stableIdAfter}. Anything that referred to it by name — prose, graph_approaches, another cycle's notes — now resolves elsewhere or not at all.`,
        );
      } else if (change === 'dropped') {
        notes.push(
          `⚠️ IDENTIFIER DROPPED: the node carried ${stableIdBefore} and the new title carries none, so graph_approaches("${stableIdBefore}") can no longer reach it. Its edges are unaffected; only resolution by name is.`,
        );
      } else if (change === 'acquired') {
        notes.push(
          `NOTE: the node now carries ${stableIdAfter}, which it did not before.`,
        );
      }
      if (sharesIdentifierWith.length > 0) {
        const sanctioned = new Set(supersedesInBatch);
        const handedOn = sharesIdentifierWith.every(
          (n) => sanctioned.has(n.id) || sanctioned.has(n.title),
        );
        const who = sharesIdentifierWith
          .map((n) => `${n.id} ("${n.title.slice(0, 70)}")`)
          .join(', ');
        notes.push(
          handedOn
            ? `RE-SPECIFICATION: ${stableIdAfter} was worn by ${who}, and this same batch draws a \`supersedes\` edge at it — the address is being handed on, not contested, so the identifier keeps resolving to exactly one live node.`
            : `⚠️ IDENTIFIER ALREADY IN USE: ${stableIdAfter} is worn by ${sharesIdentifierWith.length} other live node(s) — ${who}. That identifier now names more than one node and cannot be resolved by name at all; graph_frontier reports it under collidingIdentifiers. Give one of them a free number (graph_next_id issues one), or connect them with a \`supersedes\` edge if this is a re-specification.`,
        );
      }

      // THE ONE REFUSAL: taking an address a live node still wears, with
      // nothing in this batch superseding it.
      const capture = index
        ? findAddressCapture({
            newTitle: newName,
            renamedNodeId: resolved.id,
            index,
            supersedesInBatch,
          })
        : null;
      if (capture) {
        return {
          success: false,
          error: 'IDENTIFIER_IN_USE',
          message: `Refused: ${describeAddressCapture(capture)}`,
          stableId: capture.stableId,
          ownedBy: capture.owners,
          attemptedName: newName,
          currentName: oldName,
          hint: 'graph_rename edits the address space of the corpus. The identifier in the title is what other agents search by; taking one that is still in use is the one thing this tool will not do.',
        };
      }

      // Through `updateNode`, exactly like `graph_revise` and
      // `node_set_trigger`: the previous title — which in this corpus is the
      // previous ADDRESS — lands in `revisions` and `version` increments, so a
      // reference that stopped resolving can be traced from the node itself
      // rather than only from the event log. `GraphStore.renameNode` now takes
      // the same path for every other caller.
      const updated = store.updateNode(resolved.id, {
        title: newName,
        revisionWhy:
          typeof args.why === 'string' && args.why.trim() !== ''
            ? (args.why as string)
            : `Renamed from "${oldName}" to "${newName}"`,
        conversationId,
      });

      return {
        success: true,
        id: updated.id,
        oldName,
        newName: updated.title,
        version: updated.version,
        addressChange: {
          stableIdBefore,
          stableIdAfter,
          change,
          sharesIdentifierWith:
            sharesIdentifierWith.length > 0 ? sharesIdentifierWith : undefined,
        },
        addressWarning: notes.length > 0 ? notes.join(' ') : undefined,
        message: `Renamed "${oldName}" to "${updated.title}"`,
        hint: 'The previous title is kept in the revision history (node_get_revisions). Documents using soft references ({{char:id}}, {{concept:id}}, etc.) will automatically resolve to the new name on regeneration with doc_generate.',
      };
    }

    case 'graph_archive': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      const store = getGraphStore();
      const reason = (args.reason as string) || 'Archived by user';

      const success = store.archiveNode(resolved.id, reason, conversationId);

      if (!success) {
        throw new Error(`Failed to archive node: ${resolved.title}`);
      }

      return {
        success: true,
        id: resolved.id,
        name: resolved.title,
        reason,
        message: `Archived "${resolved.title}"`,
        hint: 'Node is hidden from default context but preserved in history. Use show_evolution in graph_context to see archived nodes.',
      };
    }

    case 'node_set_trigger': {
      const resolved = contextManager.resolveNodeWithSuggestions(
        args.node as string,
        projectId,
      );

      const store = getGraphStore();
      const existingNode = store.getNode(resolved.id);
      const oldTrigger = existingNode?.trigger;
      const newTrigger = args.trigger as TriggerType;

      const node = store.updateNode(resolved.id, {
        trigger: newTrigger,
        revisionWhy: `Changed trigger from ${oldTrigger} to ${newTrigger}`,
        conversationId,
      });

      return {
        success: true,
        id: node.id,
        name: node.title,
        oldTrigger,
        newTrigger: node.trigger,
        message: `Changed "${node.title}" trigger: ${oldTrigger} → ${newTrigger}`,
      };
    }

    default:
      throw new Error(`Unknown concept tool: ${name}`);
  }
}
