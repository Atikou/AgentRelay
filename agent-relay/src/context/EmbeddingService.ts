/** Embedding 提供方：测试用 Mock、生产可接 API。 */
export interface EmbeddingProvider {
  readonly name: string;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** Mock / 默认离线 embedding 维度；须与 LanceDB 表 schema 一致。 */
export const EMBEDDING_DIMENSION = 64;

/** 确定性伪向量，便于单测与离线环境。 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";

  async embedText(text: string): Promise<number[]> {
    return hashToVector(text, EMBEDDING_DIMENSION);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedText(t)));
  }
}

/** OpenAI-compatible embedding（需环境变量 OPENAI_API_KEY）。 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "api";

  constructor(
    private readonly opts: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    } = {},
  ) {}

  async embedText(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec ?? hashToVector(text, EMBEDDING_DIMENSION);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const apiKey = this.opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const mock = new MockEmbeddingProvider();
      return mock.embedBatch(texts);
    }
    const baseUrl = (this.opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    const model = this.opts.model ?? process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      const mock = new MockEmbeddingProvider();
      return mock.embedBatch(texts);
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding: number[] }>;
    };
    const vectors = (data.data ?? []).map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      const mock = new MockEmbeddingProvider();
      return mock.embedBatch(texts);
    }
    return vectors;
  }
}

export class EmbeddingService {
  constructor(private readonly provider: EmbeddingProvider = new MockEmbeddingProvider()) {}

  get providerName(): string {
    return this.provider.name;
  }

  embedText(text: string): Promise<number[]> {
    return this.provider.embedText(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return this.provider.embedBatch(texts);
  }
}

function hashToVector(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    const idx = i % dim;
    vec[idx] = (vec[idx]! + text.charCodeAt(i)) % 997;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}
