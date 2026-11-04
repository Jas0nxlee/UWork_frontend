import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  restartIntoWorkspace,
  seedReplayProvider,
} from "../../../helpers/model-provider-restart.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const PROVIDER_ID = "e2e-model-discovery-capabilities";
const SMALL_MODEL = "E2E_DISCOVERY_SMALL";
const VISION_MODEL = "E2E_DISCOVERY_VISION";
const UNKNOWN_MODEL = "ucas-gpt-e2e-unconfirmed";
const row = (id: string) => $(`[data-model-provider-model-id="${id}"]`);
const footer = () => $('[data-model-settings-footer="true"]');
const context = () => $('[data-model-settings-group="tokens"] input');
const source = (id: string) => row(id).$('[data-testid="model-provider-capability-source"]');

async function openProviderSettings() {
  // 重启后的登录跳过状态只属于新 Renderer；先完成真实登录遮罩处理，再操作设置。
  await prepareV4ConversationE2E({ skipProvider: true });
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${PROVIDER_ID}`));
}

async function openModel(id: string) {
  await row(id).scrollIntoView({ block: "center" });
  await row(id).$("button:has(svg.lucide-pencil)").click();
  await footer().waitForDisplayed({ timeout: 15_000 });
}

async function closeModel(save = false) {
  await footer()
    .$(
      save
        ? './/button[normalize-space(.)="Save" or normalize-space(.)="保存"]'
        : './/button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]',
    )
    .click();
  await footer().waitForExist({ reverse: true, timeout: 15_000 });
}

async function assertModelCapabilities(expected: {
  contextWindow: string;
  contextOverride?: string;
  image: boolean;
  pdf: boolean;
  reasoningLevels: string[];
}) {
  await browser.waitUntil(
    async () => (await context().getAttribute("placeholder")) === expected.contextWindow,
    { timeout: 15_000, timeoutMsg: `模型推荐上下文未更新为 ${expected.contextWindow}` },
  );
  expect(await context().getValue()).toBe(expected.contextOverride ?? "");
  await $('[data-model-advanced-trigger="true"]').click();
  for (const [modality, supported] of [
    ["image", expected.image],
    ["pdf", expected.pdf],
  ] as const) {
    expect(await $(`[data-model-input-modality="${modality}"]`).getAttribute("aria-pressed")).toBe(
      String(supported),
    );
  }
  await $('[data-model-reasoning-level-editor="true"]').scrollIntoView({ block: "center" });
  const chips = await $$('[data-model-reasoning-chip="true"]');
  const values: string[] = [];
  for (const chip of chips) values.push(await chip.$("button").getText());
  expect(values).toEqual(expected.reasoningLevels);
}

describe("网关模型发现的能力来源与刷新", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("不同模型保留实际能力，刷新保留手动覆盖，未知别名明确提示", async function () {
    this.timeout(180_000);
    let refreshed = false;
    let modelRequests = 0;
    let unexpectedRequests = 0;
    // 原因：旧发现路径只保存 ID，再用同一通用推荐伪装型号能力；本接口只返回名单，禁止推理请求。
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/v1/models") {
        unexpectedRequests++;
        response.writeHead(404).end();
        return;
      }
      modelRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              id: SMALL_MODEL,
              context_window: refreshed ? 65_536 : 32_768,
              max_output_tokens: 8_192,
              supports_vision: refreshed,
              architecture: { input_modalities: refreshed ? ["text", "image"] : ["text"] },
              reasoning_levels: refreshed ? ["low", "medium", "high"] : ["low", "high"],
            },
            {
              id: VISION_MODEL,
              context_window: 131_072,
              max_output_tokens: 16_384,
              architecture: { input_modalities: ["text", "image", "pdf"] },
              reasoning_levels: ["high", "max"],
            },
            { id: UNKNOWN_MODEL },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing discovery server port");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    const artifacts = join(
      process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
      "provider-model-discovery-capabilities",
    );
    await mkdir(artifacts, { recursive: true });
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: PROVIDER_ID,
            name: "E2E Model Discovery Capabilities",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [],
          }),
      });
      await openProviderSettings();
      const discover = () => $('[data-testid="model-provider-discover-models-button"]');
      await browser.saveScreenshot(join(artifacts, "before-discovery.png"));
      await discover().scrollIntoView({ block: "center" });
      await discover().waitForClickable({ timeout: 15_000 });
      await discover().click();
      await row(SMALL_MODEL).waitForDisplayed({ timeout: 15_000 });
      await row(VISION_MODEL).waitForDisplayed({ timeout: 15_000 });
      expect(modelRequests).toBe(1);
      expect(await source(SMALL_MODEL).getAttribute("data-capability-source")).toBe("gateway");
      expect(await source(VISION_MODEL).getAttribute("data-capability-source")).toBe("gateway");
      await openModel(SMALL_MODEL);
      await assertModelCapabilities({
        contextWindow: "32768",
        image: false,
        pdf: false,
        reasoningLevels: ["low", "high"],
      });
      await context().setValue("49152");
      await closeModel(true);
      expect(
        (await repository.read()).models.getExact(PROVIDER_ID, SMALL_MODEL)?.properties
          ?.contextWindow,
      ).toBe(49_152);

      await openModel(VISION_MODEL);
      await assertModelCapabilities({
        contextWindow: "131072",
        image: true,
        pdf: true,
        reasoningLevels: ["high", "max"],
      });
      await browser.saveScreenshot(join(artifacts, "gateway-model-capabilities.png"));
      await closeModel();

      refreshed = true;
      await discover().click();
      await browser.waitUntil(() => modelRequests === 2, { timeout: 15_000 });
      await discover().waitForClickable({ timeout: 15_000 });
      await openModel(SMALL_MODEL);
      await assertModelCapabilities({
        contextWindow: "65536",
        contextOverride: "49152",
        image: true,
        pdf: false,
        reasoningLevels: ["low", "medium", "high"],
      });
      await browser.saveScreenshot(join(artifacts, "refreshed-with-manual-override.png"));
      await closeModel();

      await restartIntoWorkspace();
      await openProviderSettings();
      await openModel(SMALL_MODEL);
      await assertModelCapabilities({
        contextWindow: "65536",
        contextOverride: "49152",
        image: true,
        pdf: false,
        reasoningLevels: ["low", "medium", "high"],
      });
      await closeModel();
      expect(await source(UNKNOWN_MODEL).getAttribute("data-capability-source")).toBe("unknown");
      await openModel(UNKNOWN_MODEL);
      const notice = $(
        '[role="dialog"] [data-testid="model-provider-capability-source"][data-model-capability-source="unknown"]',
      );
      await notice.waitForDisplayed({ timeout: 15_000 });
      expect(await notice.getText()).toMatch(/能力未确认|capabilities unconfirmed/i);
      expect(await notice.getText()).toMatch(/兼容默认值|compatibility defaults/i);
      await browser.saveScreenshot(join(artifacts, "unknown-model-capabilities.png"));
      await closeModel();
      expect(modelRequests).toBe(2);
      expect(unexpectedRequests).toBe(0);
    } finally {
      repository.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
