import type { RerankDocument } from "openclaw/plugin-sdk/memory-core-host-engine-reranker";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS,
  ExternalMmrReranker,
  resolveRerankerNetworkPolicy,
  setExternalRerankerFetchGuardForTesting,
} from "./reranker.js";

afterEach(() => {
  setExternalRerankerFetchGuardForTesting(null);
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeTestConfig(
  providers: Record<
    string,
    { baseUrl: string; apiKey?: unknown; request?: { allowPrivateNetwork?: boolean } }
  >,
) {
  return {
    models: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([id, entry]) => [
          id,
          { baseUrl: entry.baseUrl, apiKey: entry.apiKey, request: entry.request },
        ]),
      ),
    },
  } as unknown as Parameters<typeof ExternalMmrReranker>[1];
}

function mockOkGuard(results: Array<{ index: number; relevance_score: number }>) {
  const fn = vi.fn(async () => ({
    response: {
      ok: true,
      status: 200,
      json: async () => ({ results }),
      text: async () => "",
    },
    release: async () => {},
  }));
  setExternalRerankerFetchGuardForTesting(fn as unknown as typeof fetchWithSsrFGuard);
  return fn;
}

function guardCallOpts(fn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  return fn.mock.calls[index]?.[0] as Record<string, unknown>;
}

function guardCallBody(fn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const init = guardCallOpts(fn, index).init as { body?: string };
  return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
}

const sampleDocs: RerankDocument[] = [
  { id: "doc-1", content: "machine learning neural networks", score: 0.8 },
  { id: "doc-2", content: "database sql queries", score: 0.6 },
  { id: "doc-3", content: "machine learning algorithms", score: 0.4 },
];

describe("ExternalMmrReranker", () => {
  it("sends one fetch to the configured provider with the expected body", async () => {
    const mock = mockOkGuard([
      { index: 0, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.5 },
      { index: 2, relevance_score: 0.3 },
    ]);

    const reranker = new ExternalMmrReranker(
      {
        provider: "local",
        model: "qwen3-reranker",
        allowPrivateNetwork: true,
      },
      makeTestConfig({ local: { baseUrl: "http://localhost:8080" } }),
    );

    await reranker.rerank({ query: "neural networks", documents: sampleDocs, limit: 10 });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(guardCallOpts(mock).url).toBe("http://localhost:8080/v1/rerank");
    expect(guardCallOpts(mock).timeoutMs).toBe(DEFAULT_EXTERNAL_RERANKER_TIMEOUT_MS);
    expect(guardCallOpts(mock).policy).toMatchObject({ allowPrivateNetwork: true });
    expect(guardCallBody(mock)).toMatchObject({
      query: "neural networks",
      documents: [
        "machine learning neural networks",
        "database sql queries",
        "machine learning algorithms",
      ],
      top_n: 10,
      model: "qwen3-reranker",
    });
  });

  it("passes additional body params through to the rerank request", async () => {
    const mock = mockOkGuard([{ index: 0, relevance_score: 0.8 }]);

    const reranker = new ExternalMmrReranker(
      {
        provider: "local",
        model: "qwen3-reranker",
        allowPrivateNetwork: true,
        additionalBodyParams: { truncation: true },
      },
      makeTestConfig({ local: { baseUrl: "http://localhost:8080" } }),
    );

    await reranker.rerank({ query: "test", documents: sampleDocs.slice(0, 1), limit: 1 });

    expect(guardCallBody(mock)).toMatchObject({ truncation: true });
  });

  it("uses an SSRF policy when private-network access is explicitly allowed", async () => {
    const mock = mockOkGuard([{ index: 0, relevance_score: 0.9 }]);

    const reranker = new ExternalMmrReranker(
      {
        provider: "local",
        model: "qwen3-reranker",
        allowPrivateNetwork: true,
      },
      makeTestConfig({ local: { baseUrl: "http://127.0.0.1:8082" } }),
    );

    await reranker.rerank({ query: "test", documents: sampleDocs.slice(0, 1), limit: 1 });

    expect(guardCallOpts(mock).policy).toMatchObject({ allowPrivateNetwork: true });
  });

  it("uses the provider request.allowPrivateNetwork setting for private hosts", async () => {
    const mock = mockOkGuard([{ index: 0, relevance_score: 0.9 }]);

    const reranker = new ExternalMmrReranker(
      {
        provider: "local",
        model: "qwen3-reranker",
      },
      makeTestConfig({
        local: {
          baseUrl: "http://127.0.0.1:8082",
          request: { allowPrivateNetwork: true },
        },
      }),
    );

    await reranker.rerank({ query: "test", documents: sampleDocs.slice(0, 1), limit: 1 });

    expect(guardCallOpts(mock).policy).toMatchObject({ allowPrivateNetwork: true });
  });

  it("returns an SSRF policy for private hosts when opted in", () => {
    expect(
      resolveRerankerNetworkPolicy({ baseUrl: "http://127.0.0.1:8082", allowPrivateNetwork: true }),
    ).toMatchObject({
      allowPrivateNetwork: true,
    });
  });

  describe("API key SecretRef resolution", () => {
    it("throws and does not fetch when a configured SecretRef cannot be resolved", async () => {
      const mockFn = vi.fn();
      setExternalRerankerFetchGuardForTesting(mockFn);
      // Reference an env var that is guaranteed absent in this test.
      vi.stubEnv("RERANKER_TEST_MISSING_KEY_8f3c2", undefined as never);

      const reranker = new ExternalMmrReranker(
        { provider: "cohere", model: "rerank-english-v3.0" },
        makeTestConfig({
          cohere: {
            baseUrl: "https://api.cohere.ai",
            apiKey: { source: "env", provider: "default", id: "RERANKER_TEST_MISSING_KEY_8f3c2" },
          },
        }),
      );

      const docs: RerankDocument[] = [{ id: "doc-1", content: "hello", score: 0.5 }];
      await expect(reranker.rerank({ query: "test", documents: docs, limit: 5 })).rejects.toThrow(
        /API key SecretRef for provider cohere could not be resolved/,
      );
      expect(mockFn).not.toHaveBeenCalled();
    });
  });
});
