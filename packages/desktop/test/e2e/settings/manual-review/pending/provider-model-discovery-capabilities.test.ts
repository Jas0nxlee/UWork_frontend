import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { createModelsDevCatalog } from "@zcode/services/model-catalog";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
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
const CATALOG_MODEL = "e2e-catalog-chat";
const IMAGE_MODEL = "e2e-catalog-image-only";
const row = (id: string) => $(`[data-model-provider-model-id="${id}"]`);
const footer = () => $('[data-model-settings-footer="true"]');
const context = () => $('[data-model-settings-group="tokens"] input');
const source = (id: string) => row(id).$('[data-testid="model-provider-capability-source"]');

function catalogFixture(refreshed = false) {
  return {
    openai: {
      id: "openai",
      models: {
        [CATALOG_MODEL]: {
          id: CATALOG_MODEL,
          canonical_model_id: `openai/${CATALOG_MODEL}`,
          limit: { context: refreshed ? 524_288 : 262_144, output: refreshed ? 96_000 : 64_000 },
          modalities: {
            input: ["text", "image/png", "audio/wav", "video/mp4", "application/pdf"],
            output: ["text"],
          },
          reasoning: true,
          reasoning_options: [
            {
              type: "effort",
              values: refreshed ? ["low", "medium", "high", "max"] : ["low", "high", "max"],
            },
          ],
          tool_call: true,
        },
        [IMAGE_MODEL]: {
          id: IMAGE_MODEL,
          canonical_model_id: `openai/${IMAGE_MODEL}`,
          limit: { context: 0, output: 0 },
          modalities: { input: ["image/png"], output: ["image/png"] },
          reasoning: false,
        },
      },
    },
  };
}

async function seedCatalog(refreshed = false) {
  const cachePath = join(
    dirname(getE2EAppDataPaths().configFile),
    "model-catalog",
    "models-dev.json",
  );
  await rm(cachePath, { force: true });
  const catalog = createModelsDevCatalog({
    cachePath,
    request: async () => Response.json(catalogFixture(refreshed)),
  });
  try {
    await catalog.enrich(
      { apiType: "openai-chat-completions", baseUrl: "https://gateway.example/v1" },
      [CATALOG_MODEL],
    );
  } finally {
    catalog.dispose();
  }
}

async function screenshot(path: string) {
  // 等待真实 CSS 过渡完成，避免截图捕获展开过程造成内容被截断。
  await browser.execute(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState !== "finished" &&
            animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await browser.saveScreenshot(path);
}

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
  audio?: boolean;
  video?: boolean;
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
    ...(expected.audio === undefined ? [] : ([["audio", expected.audio]] as const)),
    ...(expected.video === undefined ? [] : ([["video", expected.video]] as const)),
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

describe("模型名单发现与目录能力刷新", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("无目录命中使用内置默认，刷新保留手动覆盖并明确提示来源", async function () {
    this.timeout(180_000);
    let refreshed = false;
    let modelRequests = 0;
    let unexpectedRequests = 0;
    // 原因：网关额外规格不进入自动层：仅取模型名单，未命中目录时应明确显示内置兼容默认，禁止推理请求。
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
        afterElectronProcessExit: async () => {
          await seedCatalog();
          await seedReplayProvider({
            id: PROVIDER_ID,
            name: "E2E Model Discovery Capabilities",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [],
          });
        },
      });
      await openProviderSettings();
      const discover = () => $('[data-testid="model-provider-discover-models-button"]');
      await screenshot(join(artifacts, "before-discovery.png"));
      await discover().scrollIntoView({ block: "center" });
      await discover().waitForClickable({ timeout: 15_000 });
      await discover().click();
      await row(SMALL_MODEL).waitForDisplayed({ timeout: 15_000 });
      await row(VISION_MODEL).waitForDisplayed({ timeout: 15_000 });
      expect(modelRequests).toBe(1);
      expect(await source(SMALL_MODEL).getAttribute("data-capability-source")).toBe("unknown");
      expect(await source(VISION_MODEL).getAttribute("data-capability-source")).toBe("unknown");
      await openModel(SMALL_MODEL);
      await assertModelCapabilities({
        contextWindow: "200000",
        image: false,
        pdf: false,
        reasoningLevels: ["disabled", "enabled"],
      });
      await context().setValue("49152");
      await closeModel(true);
      expect(
        (await repository.read()).models.getExact(PROVIDER_ID, SMALL_MODEL)?.properties
          ?.contextWindow,
      ).toBe(49_152);

      await openModel(VISION_MODEL);
      await assertModelCapabilities({
        contextWindow: "200000",
        image: false,
        pdf: false,
        reasoningLevels: ["disabled", "enabled"],
      });
      await screenshot(join(artifacts, "builtin-default-capabilities.png"));
      await closeModel();

      refreshed = true;
      await discover().click();
      await browser.waitUntil(() => modelRequests === 2, { timeout: 15_000 });
      await discover().waitForClickable({ timeout: 15_000 });
      await openModel(SMALL_MODEL);
      await assertModelCapabilities({
        contextWindow: "200000",
        contextOverride: "49152",
        image: false,
        pdf: false,
        reasoningLevels: ["disabled", "enabled"],
      });
      await screenshot(join(artifacts, "refreshed-with-manual-override.png"));
      await closeModel();

      await restartIntoWorkspace();
      await openProviderSettings();
      await openModel(SMALL_MODEL);
      await assertModelCapabilities({
        contextWindow: "200000",
        contextOverride: "49152",
        image: false,
        pdf: false,
        reasoningLevels: ["disabled", "enabled"],
      });
      await closeModel();
      expect(await source(UNKNOWN_MODEL).getAttribute("data-capability-source")).toBe("unknown");
      await openModel(UNKNOWN_MODEL);
      const notice = $(
        '[role="dialog"] [data-testid="model-provider-capability-source"][data-model-capability-source="unknown"]',
      );
      await notice.waitForDisplayed({ timeout: 15_000 });
      expect(await notice.getText()).toMatch(/能力未确认|capabilities unconfirmed/i);
      expect(await notice.getText()).toMatch(/未匹配到 models\.dev|No matching models\.dev/i);
      expect(await notice.getText()).toMatch(/软件内置默认配置|built-in default configuration/i);
      await screenshot(join(artifacts, "unknown-model-capabilities.png"));
      await closeModel();
      expect(modelRequests).toBe(2);
      expect(unexpectedRequests).toBe(0);
    } finally {
      repository.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("目录优先于网关，五类输入与手动推理重启保留，非聊天型号不可探测或选择", async function () {
    this.timeout(180_000);
    let modelRequests = 0;
    let unexpectedRequests = 0;
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
              id: CATALOG_MODEL,
              context_window: 4096,
              max_output_tokens: 1024,
              supports_vision: false,
              architecture: { input_modalities: ["text"] },
              reasoning_levels: ["low"],
            },
            { id: IMAGE_MODEL },
            { id: UNKNOWN_MODEL },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing catalog discovery port");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    const artifacts = join(
      process.env.ZCODE_E2E_ARTIFACT_DIR || join(process.cwd(), ".e2e-artifacts"),
      "provider-model-catalog-capabilities",
    );
    await mkdir(artifacts, { recursive: true });
    try {
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          await seedCatalog();
          await seedReplayProvider({
            id: PROVIDER_ID,
            name: "E2E Catalog Capabilities",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [],
          });
        },
      });
      await openProviderSettings();
      const discover = () => $('[data-testid="model-provider-discover-models-button"]');
      await discover().scrollIntoView({ block: "center" });
      await discover().click();
      await row(CATALOG_MODEL).waitForDisplayed({ timeout: 15_000 });
      await browser.waitUntil(
        async () =>
          (await source(CATALOG_MODEL).getAttribute("data-capability-source")) === "catalog",
        { timeout: 15_000 },
      );
      await openModel(CATALOG_MODEL);
      await assertModelCapabilities({
        contextWindow: "262144",
        image: true,
        audio: true,
        video: true,
        pdf: true,
        reasoningLevels: ["low", "high", "max"],
      });
      expect(await $('[role="dialog"]').getText()).toMatch(/models\.dev/);
      const modalities = $('[data-model-settings-group="modalities"]');
      await modalities.scrollIntoView({ block: "center" });
      expect(await modalities.getText()).toMatch(
        /暂不支持音频附件|does not yet support audio attachments/,
      );
      await screenshot(join(artifacts, "catalog-five-input-capabilities.png"));
      await context().setValue("245760");
      for (const modality of ["image", "audio", "video", "pdf"]) {
        const button = $(`[data-model-input-modality="${modality}"]`);
        await button.scrollIntoView({ block: "center" });
        await button.click();
      }
      const maxChip = $('[data-model-reasoning-chip="true"]:has(button[aria-label$=": max"])');
      await maxChip.scrollIntoView({ block: "center" });
      await maxChip.moveTo();
      await maxChip.$('button[aria-label$=": max"]').click();
      await closeModel(true);
      const personal = (await repository.read()).models
        .getExact(PROVIDER_ID, CATALOG_MODEL)
        ?.toJSON();
      expect(personal?.properties?.contextWindow).toBe(245_760);
      expect(personal?.properties?.inputFormat).toMatchObject({
        supportsImage: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsPdf: false,
      });
      expect(personal?.optionSpecs?.reasoningLevel?.values).toEqual(["low", "high"]);

      await restartIntoWorkspace({ afterElectronProcessExit: () => seedCatalog(true) });
      await openProviderSettings();
      await openModel(CATALOG_MODEL);
      await assertModelCapabilities({
        contextWindow: "524288",
        contextOverride: "245760",
        image: false,
        audio: false,
        video: false,
        pdf: false,
        reasoningLevels: ["low", "high"],
      });
      expect(await $('[data-model-max-output="true"] input').getAttribute("placeholder")).toBe(
        "96000",
      );
      await screenshot(join(artifacts, "catalog-refresh-manual-overrides.png"));
      await closeModel();

      await row(IMAGE_MODEL).scrollIntoView({ block: "center" });
      expect(await row(IMAGE_MODEL).$("button:has(svg.lucide-unplug)").isEnabled()).toBe(false);
      expect(await row(IMAGE_MODEL).getText()).toMatch(/不适用于聊天|not suitable for chat/);
      expect(
        await row(IMAGE_MODEL)
          .$('[aria-label^="上下文窗口："], [aria-label^="Context window:"]')
          .isExisting(),
      ).toBe(false);
      await openModel(IMAGE_MODEL);
      expect(await $('[data-model-settings-group="tokens"]').isExisting()).toBe(false);
      await $('[data-model-advanced-trigger="true"]').click();
      const textInput = $('[data-model-input-modality="text"]');
      expect(await textInput.getAttribute("aria-pressed")).toBe("false");
      expect(await textInput.isEnabled()).toBe(false);
      await screenshot(join(artifacts, "non-chat-model-capabilities.png"));
      await closeModel();
      expect(await source(UNKNOWN_MODEL).getAttribute("data-capability-source")).toBe("unknown");
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).click();
      await $('[data-testid="composer-provider-trigger"]').click();
      await $(
        `[data-testid="${testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${PROVIDER_ID}`)}"]`,
      ).click();
      expect(
        await $(
          `[data-testid="${testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(PROVIDER_ID, CATALOG_MODEL))}"]`,
        ).isExisting(),
      ).toBe(true);
      expect(
        await $(
          `[data-testid="${testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(PROVIDER_ID, IMAGE_MODEL))}"]`,
        ).isExisting(),
      ).toBe(false);
      expect(modelRequests).toBe(1);
      expect(unexpectedRequests).toBe(0);
    } finally {
      repository.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
