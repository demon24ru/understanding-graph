#!/usr/bin/env node
/**
 * Verify the embedding configuration end to end.
 *
 * Run this once an OPENROUTER_API_KEY is available, before switching the MCP
 * server over. It makes one real embedding request and checks that the vector
 * that comes back is the width the database schema was built for — the single
 * failure that would otherwise show up much later, as a write error deep
 * inside graph_backfill_embeddings.
 *
 *   node scripts/check-embeddings.mjs
 *
 * Environment (same variables the MCP server uses):
 *   UG_EMBEDDING_PROVIDER=openrouter
 *   OPENROUTER_API_KEY=sk-or-...
 *   UG_EMBEDDING_MODEL=openai/text-embedding-3-small
 *   UG_EMBEDDING_DIM=1536
 *
 * Exit code 0 on success, 1 on any misconfiguration.
 */

import { verifyEmbeddingConfig } from '../packages/core/dist/services/EmbeddingService.js';

try {
  const info = await verifyEmbeddingConfig();

  console.log('provider        :', info.provider);
  if (info.baseUrl) console.log('base url        :', info.baseUrl);
  console.log('model           :', info.model);
  console.log('UG_EMBEDDING_DIM:', info.configuredDim);
  console.log('returned dims   :', info.actualDim);

  if (info.actualDim !== info.configuredDim) {
    console.error(
      `\nFAIL: the model returned ${info.actualDim} dimensions but UG_EMBEDDING_DIM is ` +
        `${info.configuredDim}. The Postgres column is vector(${info.configuredDim}), so every ` +
        'embedding write would be rejected. Set UG_EMBEDDING_DIM to the real width — while ' +
        'nodes.embedding is still empty the backend will widen the column automatically on ' +
        'next startup.',
    );
    process.exit(1);
  }

  console.log('\nOK: embeddings are configured correctly.');
  process.exit(0);
} catch (err) {
  console.error('FAIL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
