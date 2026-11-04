import type { ModelsDevCatalog } from "./contract.js";

export function enrichDiscoveredModels(catalog: ModelsDevCatalog) {
  return catalog.enrich(
    { apiType: "openai-chat-completions", baseUrl: "https://gateway.example/v1" },
    ["gpt-6.1-sol", { id: "private-alias", preserveCapabilities: true }],
  );
}
