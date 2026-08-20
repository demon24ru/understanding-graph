/**
 * EmbeddingService — semantic embeddings for nodes.
 *
 * Two providers, selected by UG_EMBEDDING_PROVIDER:
 *
 *   openrouter  HTTP call to an OpenAI-compatible /embeddings endpoint.
 *   local       @xenova/transformers running the model in-process. This is
 *               the original behaviour and remains the default, so an existing
 *               install keeps working with no environment changes and there is
 *               always a way back.
 *
 * Environment
 * -----------
 *   UG_EMBEDDING_PROVIDER   openrouter | local            (default: local)
 *   UG_EMBEDDING_MODEL      model id                      (provider-specific default)
 *   UG_EMBEDDING_DIM        vector dimension              (see below)
 *   OPENROUTER_API_KEY      required when provider=openrouter
 *   OPENROUTER_BASE_URL     default https://openrouter.ai/api/v1
 *   UG_EMBEDDING_TIMEOUT_MS default 30000
 *   UG_EMBEDDING_RETRIES    default 3   (retries on 429/5xx/network, backoff)
 *   UG_EMBEDDING_BATCH      default 32  (inputs per request)
 *
 * On UG_EMBEDDING_DIM: the Postgres backend types nodes.embedding as
 * vector(UG_EMBEDDING_DIM), so this value is part of the schema, not a hint.
 * With provider=openrouter it must be set explicitly — guessing it would
 * silently build a column that every write then fails against, and different
 * embedding models disagree about their width. With provider=local it defaults
 * to the 384 dimensions of all-MiniLM-L6-v2, which is what the existing
 * corpora were built with.
 */

// Dynamic import for transformers.js (ESM)
// biome-ignore lint/suspicious/noExplicitAny: transformers.js types are dynamic
let pipeline: any = null;
// biome-ignore lint/suspicious/noExplicitAny: transformers.js types are dynamic
let embeddingPipeline: any = null;

const LOCAL_MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'; // 384 dimensions
const LOCAL_EMBEDDING_DIM = 384;
const DEFAULT_OPENROUTER_MODEL = 'openai/text-embedding-3-small';

export type EmbeddingProvider = 'openrouter' | 'local';

export function getEmbeddingProvider(): EmbeddingProvider {
  const raw = (process.env.UG_EMBEDDING_PROVIDER ?? 'local').trim().toLowerCase();
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'local' || raw === 'xenova' || raw === '') return 'local';
  throw new Error(
    `UG_EMBEDDING_PROVIDER="${raw}" is not a known provider. Use "openrouter" or "local".`,
  );
}

export function getEmbeddingModel(): string {
  const configured = process.env.UG_EMBEDDING_MODEL?.trim();
  if (configured) return configured;
  return getEmbeddingProvider() === 'openrouter'
    ? DEFAULT_OPENROUTER_MODEL
    : LOCAL_MODEL_NAME;
}

/**
 * Vector dimension. Synchronous and side-effect free: the Postgres schema
 * builder calls this before any network access is possible.
 */
export function getEmbeddingDimension(): number {
  const raw = process.env.UG_EMBEDDING_DIM?.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 16000) {
      throw new Error(
        `UG_EMBEDDING_DIM="${raw}" is not a usable vector dimension. Give a positive integer, e.g. 1536.`,
      );
    }
    return n;
  }
  if (getEmbeddingProvider() === 'openrouter') {
    throw new Error(
      'UG_EMBEDDING_DIM is not set. With UG_EMBEDDING_PROVIDER=openrouter the dimension cannot be ' +
        'inferred — it is fixed by the embedding model and it defines the width of the ' +
        'nodes.embedding column in Postgres. Set it to the output dimension of ' +
        `UG_EMBEDDING_MODEL (currently "${getEmbeddingModel()}"); for example ` +
        'text-embedding-3-small is 1536 and text-embedding-3-large is 3072.',
    );
  }
  return LOCAL_EMBEDDING_DIM;
}

function getOpenRouterBaseUrl(): string {
  const raw = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').trim();
  return raw.replace(/\/+$/, '');
}

function getOpenRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'OPENROUTER_API_KEY не задан / is not set. UG_EMBEDDING_PROVIDER=openrouter requires an ' +
        'OpenRouter API key. Add OPENROUTER_API_KEY to the env block of the MCP server definition, ' +
        'or set UG_EMBEDDING_PROVIDER=local to fall back to the in-process model. ' +
        'Embedding-backed tools (graph_semantic_search, graph_similar, graph_semantic_gaps, ' +
        'graph_backfill_embeddings) will not run without one — this backend never returns ' +
        'zero vectors as a substitute, because a zero vector is a silently wrong answer.',
    );
  }
  return key;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /embeddings against an OpenAI-compatible endpoint, with retries on the
 * failures that are actually transient (429, 5xx, network reset).
 */
async function openRouterEmbed(inputs: string[]): Promise<Float32Array[]> {
  const key = getOpenRouterKey();
  const model = getEmbeddingModel();
  const url = `${getOpenRouterBaseUrl()}/embeddings`;
  const timeoutMs = intFromEnv('UG_EMBEDDING_TIMEOUT_MS', 30_000);
  const maxAttempts = intFromEnv('UG_EMBEDDING_RETRIES', 3) + 1;
  const expectedDim = getEmbeddingDimension();

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          // OpenRouter attributes traffic with these; harmless elsewhere.
          'HTTP-Referer': 'https://github.com/emergent-wisdom/understanding-graph',
          'X-Title': 'understanding-graph',
        },
        body: JSON.stringify({ model, input: inputs }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(
          `Embedding request failed: HTTP ${res.status} ${res.statusText} from ${url} ` +
            `(model "${model}"). ${body.slice(0, 500)}`,
        );
        if (!retryable || attempt === maxAttempts) throw err;
        lastError = err;
        await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
        continue;
      }

      const json = (await res.json()) as {
        data?: Array<{ embedding: number[] | string; index?: number }>;
        error?: { message?: string };
      };

      if (json.error) {
        throw new Error(
          `Embedding endpoint returned an error for model "${model}": ${json.error.message ?? JSON.stringify(json.error)}`,
        );
      }
      if (!Array.isArray(json.data) || json.data.length !== inputs.length) {
        throw new Error(
          `Embedding endpoint returned ${json.data?.length ?? 0} vectors for ${inputs.length} inputs ` +
            `(model "${model}"). Refusing to guess which input each belongs to.`,
        );
      }

      // Preserve request order: the API may return data out of order but each
      // element carries its index.
      const ordered = [...json.data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );

      return ordered.map((d) => {
        const vec = d.embedding;
        if (!Array.isArray(vec)) {
          throw new Error(
            `Embedding endpoint returned a non-array embedding for model "${model}". ` +
              'Base64 embedding encoding is not supported; do not set encoding_format.',
          );
        }
        if (vec.length !== expectedDim) {
          throw new Error(
            `Embedding dimension mismatch: model "${model}" returned ${vec.length} dimensions but ` +
              `UG_EMBEDDING_DIM is ${expectedDim}. The Postgres nodes.embedding column is vector(${expectedDim}), ` +
              'so writing this vector would fail. Set UG_EMBEDDING_DIM to the model\'s real width ' +
              '(and re-embed the corpus if it already holds vectors of the old width).',
          );
        }
        return new Float32Array(vec);
      });
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError';
      const transient =
        isAbort ||
        (err as { code?: string })?.code === 'ECONNRESET' ||
        (err as { cause?: unknown })?.cause !== undefined;
      lastError = err;
      if (attempt === maxAttempts || !transient) {
        if (isAbort) {
          throw new Error(
            `Embedding request to ${url} timed out after ${timeoutMs} ms (model "${model}"). ` +
              'Raise UG_EMBEDDING_TIMEOUT_MS or reduce UG_EMBEDDING_BATCH.',
          );
        }
        throw err;
      }
      await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Embedding request failed for an unknown reason');
}

/**
 * Initialize the local embedding pipeline (lazy loading).
 *
 * `@xenova/transformers` is a peerDependency so a fresh `npx -y
 * understanding-graph` install does NOT pay the ~160MB onnxruntime download
 * cost up front.
 */
// biome-ignore lint/suspicious/noExplicitAny: transformers.js types are dynamic
async function getEmbeddingPipeline(): Promise<any> {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  if (!pipeline) {
    try {
      const transformers = await import('@xenova/transformers');
      pipeline = transformers.pipeline;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        'Embedding features (graph_semantic_search, graph_similar, ' +
          'graph_semantic_gaps, graph_backfill_embeddings) require the optional ' +
          '@xenova/transformers peer dependency, which is not installed. ' +
          'Install it with:  npm install @xenova/transformers  (or  npm install -g @xenova/transformers  ' +
          'if you launched understanding-graph via npx), or switch to the hosted provider with ' +
          'UG_EMBEDDING_PROVIDER=openrouter. For keyword-only search without embeddings, ' +
          'use graph_search_metadata or graph_find_by_trigger instead. ' +
          `Original import error: ${reason}`,
      );
    }
  }

  const model = getEmbeddingModel();
  console.error(`[EmbeddingService] Loading local model ${model}...`);
  embeddingPipeline = await pipeline('feature-extraction', model, {
    quantized: true,
  });
  console.error('[EmbeddingService] Model loaded successfully');

  return embeddingPipeline;
}

async function localEmbed(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getEmbeddingPipeline();
  const out: Float32Array[] = [];
  for (const text of texts) {
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    out.push(new Float32Array(result.data));
  }
  return out;
}

/**
 * Generate embeddings for many texts at once. Batched according to
 * UG_EMBEDDING_BATCH so a large backfill does not become one enormous request.
 */
export async function generateEmbeddings(
  texts: string[],
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const truncated = texts.map((t) => t.slice(0, 8000));

  if (getEmbeddingProvider() === 'local') {
    return localEmbed(truncated);
  }

  const batchSize = intFromEnv('UG_EMBEDDING_BATCH', 32);
  const out: Float32Array[] = [];
  for (let i = 0; i < truncated.length; i += batchSize) {
    const chunk = truncated.slice(i, i + batchSize);
    out.push(...(await openRouterEmbed(chunk)));
  }
  return out;
}

/**
 * Generate embedding for a text string
 * @param text - The text to embed
 * @returns Float32Array of embedding values
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const [vec] = await generateEmbeddings([text]);
  return vec;
}

/**
 * Generate embedding for a node (combines title, understanding, why)
 * @param node - Object with title, understanding, and why fields
 * @returns Float32Array of embedding values
 */
export async function generateNodeEmbedding(node: {
  title: string;
  understanding?: string | null;
  why?: string | null;
}): Promise<Float32Array> {
  // Combine fields for richer semantic representation
  const parts = [node.title];
  if (node.understanding) parts.push(node.understanding);
  if (node.why) parts.push(node.why);

  const combinedText = parts.join(' ');
  return generateEmbedding(combinedText);
}

/**
 * Convert Float32Array to Buffer for storage.
 * SQLite stores this as a BLOB; the Postgres backend recognises the Buffer and
 * writes it to the pgvector column.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Convert a stored Buffer back to a Float32Array
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

/**
 * Compute cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Find k nearest neighbors by cosine similarity
 */
export function findNearestNeighbors(
  queryEmbedding: Float32Array,
  candidates: Array<{ id: string; embedding: Float32Array }>,
  k: number = 10,
): Array<{ id: string; similarity: number }> {
  const scored = candidates.map((c) => ({
    id: c.id,
    similarity: cosineSimilarity(queryEmbedding, c.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, k);
}

/**
 * Check if the local model is loaded. Always false for hosted providers,
 * which hold no in-process state.
 */
export function isModelLoaded(): boolean {
  return embeddingPipeline !== null;
}

/**
 * Preload the model (call at startup to avoid first-query delay).
 * A no-op for hosted providers.
 */
export async function preloadModel(): Promise<void> {
  if (getEmbeddingProvider() === 'local') {
    await getEmbeddingPipeline();
  }
}

/**
 * One-shot configuration check: proves the configured provider actually
 * answers, and that the vector it returns is the width the schema expects.
 * Used by `scripts/check-embeddings.mjs`.
 */
export async function verifyEmbeddingConfig(): Promise<{
  provider: EmbeddingProvider;
  model: string;
  configuredDim: number;
  actualDim: number;
  baseUrl?: string;
}> {
  const provider = getEmbeddingProvider();
  const model = getEmbeddingModel();
  const configuredDim = getEmbeddingDimension();
  const vec = await generateEmbedding(
    'understanding-graph embedding configuration check',
  );
  return {
    provider,
    model,
    configuredDim,
    actualDim: vec.length,
    baseUrl: provider === 'openrouter' ? getOpenRouterBaseUrl() : undefined,
  };
}
