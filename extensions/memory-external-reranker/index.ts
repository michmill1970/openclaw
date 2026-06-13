import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ExternalMmrReranker, type ExternalRerankerConfig } from "./src/reranker.js";

export default definePluginEntry({
  id: "memory-external-reranker",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as Partial<ExternalRerankerConfig>;
    api.registerMemoryReranker(
      new ExternalMmrReranker(
        {
          provider: cfg.provider ?? "",
          model: cfg.model ?? "",
          modelFallbacks: cfg.modelFallbacks,
          endpointPath: cfg.endpointPath,
          topN: cfg.topN,
          allowPrivateNetwork: cfg.allowPrivateNetwork,
          additionalBodyParams: cfg.additionalBodyParams,
        },
        api.config,
      ),
    );
  },
});
