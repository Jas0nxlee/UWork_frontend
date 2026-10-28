import { describe, expect, it } from "vitest";
import {
  zcodeStoragePathReadySchema,
  zcodeStoragePreparationFrameSchema,
  ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS,
} from "../src/zcode-protocol/index.js";

describe("storage preparation migration handshake", () => {
  it("fits schema-maximum escaped paths in the single shared frame budget", () => {
    const path = "\u0001".repeat(32768);
    const pathFrame = { method: "startup/storagePath", params: { path, legacySourcePath: path } };
    const ack = { method: "startup/storagePathReady", ownershipManifestPath: path };
    expect(zcodeStoragePreparationFrameSchema.parse(pathFrame)).toEqual(pathFrame);
    expect(zcodeStoragePathReadySchema.parse(ack)).toEqual(ack);
    expect(JSON.stringify(pathFrame).length).toBeGreaterThan(65536);
    expect(JSON.stringify(pathFrame).length).toBeLessThanOrEqual(
      ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS,
    );
    expect(JSON.stringify(ack).length).toBeLessThanOrEqual(
      ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS,
    );
  });
  it("accepts bounded legacy and ownership file paths without transporting session records", () => {
    expect(
      zcodeStoragePreparationFrameSchema.parse({
        method: "startup/storagePath",
        params: { path: "/product/db.sqlite", legacySourcePath: "/legacy/db.sqlite" },
      }),
    ).toMatchObject({ params: { legacySourcePath: "/legacy/db.sqlite" } });
    expect(
      zcodeStoragePathReadySchema.parse({
        method: "startup/storagePathReady",
        reuse: false,
        ownershipManifestPath: "/private/ownership.json",
      }),
    ).toMatchObject({ ownershipManifestPath: "/private/ownership.json" });
  });

  it.each(["", "x".repeat(32769)])("rejects an invalid migration path", (path) => {
    expect(
      zcodeStoragePreparationFrameSchema.safeParse({
        method: "startup/storagePath",
        params: { path: "/product/db.sqlite", legacySourcePath: path },
      }).success,
    ).toBe(false);
    expect(
      zcodeStoragePathReadySchema.safeParse({
        method: "startup/storagePathReady",
        ownershipManifestPath: path,
      }).success,
    ).toBe(false);
  });

  it("preserves strict control frames and rejects inline ownership contents", () => {
    expect(
      zcodeStoragePathReadySchema.safeParse({
        method: "startup/storagePathReady",
        sessions: [{ sessionId: "session-1", workspacePath: "/work" }],
      }).success,
    ).toBe(false);
    expect(
      zcodeStoragePreparationFrameSchema.safeParse({
        method: "startup/storagePath",
        params: { path: "/product/db.sqlite", unexpected: true },
      }).success,
    ).toBe(false);
    expect(zcodeStoragePathReadySchema.parse({ method: "startup/storagePathReady" })).toEqual({
      method: "startup/storagePathReady",
    });
  });
});
