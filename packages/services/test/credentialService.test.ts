import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialService } from "../src/credential/credentialService.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

let home: string;
let credentialsFile: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "uwork-credential-home-"));
  setDataBaseDir(home);
  credentialsFile = join(getAppConfigDir(), "credentials.json");
});
afterEach(async () => {
  setDataBaseDir(null);
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

// 加密/并发/损坏恢复继续属于自定义 API Key 的有效合同；历史账号只验收不可读且磁盘保留。
describe("credentialService encryption", () => {
  it("notifies Host listeners only after a credential mutation is persisted", async () => {
    const observed: unknown[] = [];
    const key = "personal-provider:demo:api-key";
    const service = createCredentialService({ onDidMutate: (event) => observed.push(event) });
    await service.save(key, "secret");
    expect(
      (JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, string>)[key],
    ).toMatch(/^enc:v1:/);
    expect(observed).toEqual([{ operation: "save", key }]);
    await service.delete(key);
    expect(JSON.parse(await readFile(credentialsFile, "utf8"))).toEqual({});
    expect(observed).toEqual([
      { operation: "save", key },
      { operation: "delete", key },
    ]);
  });

  it("encrypts value before persisting and decrypts transparently on load", async () => {
    const service = createCredentialService();
    const key = "personal-provider:demo:api-key";
    await service.save(key, "plain-api-key");
    const rawStore = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, string>;
    expect(rawStore[key]).toMatch(/^enc:v1:/);
    expect(rawStore[key]).not.toContain("plain-api-key");
    await expect(service.load(key)).resolves.toBe("plain-api-key");
  });

  it("round-trips an encrypted empty value", async () => {
    const service = createCredentialService();
    const key = "provider-sync:empty-api-key";
    await service.save(key, "");
    const rawStore = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, string>;
    expect(rawStore[key]).toMatch(/^enc:v1:/);
    await expect(service.load(key)).resolves.toBe("");
  });

  it("keeps backward compatibility for legacy plaintext custom API keys", async () => {
    await mkdir(getAppConfigDir(), { recursive: true });
    const key = "personal-provider:demo:api-key";
    await writeFile(credentialsFile, JSON.stringify({ [key]: "legacy-plaintext-key" }));
    const service = createCredentialService();
    await expect(service.load(key)).resolves.toBe("legacy-plaintext-key");
    expect(await readFile(credentialsFile, "utf8")).toBe(
      JSON.stringify({ [key]: "legacy-plaintext-key" }),
    );
  });

  it.each([
    "oauth:bigmodel:access_token",
    "oauth:zai:user_info",
    "account-provider:demo:api-key",
    "zcodejwttoken",
  ])("isolates historical %s without decrypting, deleting or modifying it", async (key) => {
    const service = createCredentialService();
    await service.save(key, "historical-secret");
    await service.save("personal-provider:demo:api-key", "current-api-key");
    const before = await readFile(credentialsFile, "utf8");
    const decrypt = vi.fn(() => {
      throw new Error("must not decrypt historical account");
    });
    const isolated = createCredentialService({
      cipherProvider: { encrypt: (value) => value, decrypt },
    });
    await expect(isolated.load(key)).resolves.toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
    expect(await readFile(credentialsFile, "utf8")).toBe(before);
    await expect(service.load("personal-provider:demo:api-key")).resolves.toBe("current-api-key");
  });

  it("preserves all custom API keys when host callers save concurrently", async () => {
    const service = createCredentialService();
    const entries = Array.from(
      { length: 30 },
      (_, index) => [`personal-provider:test-${index}:api-key`, `value-${index}`] as const,
    );
    await Promise.all(entries.map(([key, value]) => service.save(key, value)));
    await Promise.all(
      entries.map(async ([key, value]) => {
        await expect(service.load(key)).resolves.toBe(value);
      }),
    );
  });

  it("backs up corrupt JSON and refuses to erase it during save", async () => {
    await mkdir(getAppConfigDir(), { recursive: true });
    await writeFile(credentialsFile, "{not-json");
    const service = createCredentialService();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await Promise.all(
      Array.from({ length: 8 }, () =>
        expect(service.load("personal-provider:new:api-key")).rejects.toThrow(
          "UWork credentials are corrupt",
        ),
      ),
    );
    await expect(service.save("personal-provider:new:api-key", "value")).rejects.toThrow(
      "UWork credentials are corrupt",
    );
    expect(await readFile(credentialsFile, "utf8")).toBe("{not-json");
    const backups = (await readdir(getAppConfigDir())).filter((file) =>
      /^credentials\.json\.corrupt-.*\.bak$/.test(file),
    );
    expect(backups).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[credentialService"),
      "read failed; refusing to overwrite corrupt credential store",
      expect.objectContaining({ credentialsFile }),
    );
  });
});
