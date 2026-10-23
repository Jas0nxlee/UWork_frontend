import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ZhipuAccountAccessConfig,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import { fileURLToPath } from "node:url";

const bundledFilePath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

describe("Account preset membership", () => {
  it("trims only individual/team defaults and keeps personal additions executable", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      // 账号目录已退役；兼容算法显式注入成员，避免依赖发布包恢复旧账号。
      expect(snapshot.providers.keys()).toEqual([]);
      const providers = new ProviderConfigMap(
        ["zai", "bigmodel"].flatMap((family) =>
          ["individual-coding-plan", "team-coding-plan", "start-plan", "offpeak-idle-plan"].map(
            (mode) =>
              [
                `account:${family}-${mode}`,
                new ProviderConfig({
                  group: family === "zai" ? "zai-family" : "bigmodel-family",
                  api: new ProviderApiConfig({
                    type: "anthropic-messages",
                    baseUrl: "https://fixture.example/anthropic",
                  }),
                  access: new ZhipuAccountAccessConfig({
                    accountType: family as "zai" | "bigmodel",
                    mode:
                      mode === "offpeak-idle-plan"
                        ? "off-peak"
                        : (mode as "individual-coding-plan" | "team-coding-plan" | "start-plan"),
                  }),
                  builtinModelIds:
                    mode === "start-plan"
                      ? ["GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"]
                      : ["GLM-5.3", "GLM-5.3-Flash"],
                }),
              ] as const,
          ),
        ),
      );
      for (const family of ["zai", "bigmodel"]) {
        for (const mode of ["individual-coding-plan", "team-coding-plan"]) {
          const providerId = `account:${family}-${mode}`;
          expect(providers.get(providerId)?.builtinModelIds).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
          const result = new ProviderConfigResolver().resolve({
            zcodeBuiltinProviders: providers,
            zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
            zcodeBuiltinModelRules: snapshot.models,
            accountProviders: new ProviderConfigMap([
              [
                providerId,
                new ProviderConfig({
                  access: new ZhipuAccountAccessConfig({ entitled: true }),
                }),
              ],
            ]),
            accountStates: {
              [providerId]: {
                availability: "available",
                entitled: true,
                current: true,
              },
            },
            personalModels: ModelConfigRules.empty(),
            personalProviders: new ProviderConfigMap([
              [
                providerId,
                new ProviderConfig({
                  personalModelIds: ["GLM-5.2", "GLM-5-Turbo"],
                }),
              ],
            ]),
          });
          expect(
            result.registryProviders
              .find((p) => p.providerId === providerId)
              ?.models.map((m) => m.modelId),
          ).toEqual(expect.arrayContaining(["GLM-5.2", "GLM-5-Turbo"]));
        }
        expect(providers.get(`account:${family}-start-plan`)?.builtinModelIds).toEqual([
          "GLM-5.3-Flash",
          "GLM-5.2",
          "GLM-5-Turbo",
        ]);
        expect(providers.get(`account:${family}-offpeak-idle-plan`)?.builtinModelIds).toContain(
          "GLM-5.3-Flash",
        );
      }
      const raw = JSON.parse(await readFile(bundledFilePath, "utf8"));
      expect(
        raw.config.modelConfigRules.modelRules.some((r: { modelMatch: string }) =>
          r.modelMatch.includes("GLM-5-Turbo"),
        ),
      ).toBe(true);
    } finally {
      source.dispose();
    }
  });
});
