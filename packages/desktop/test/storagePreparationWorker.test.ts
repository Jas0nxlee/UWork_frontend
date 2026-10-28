import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS } from "@zcode/shared";
const resolver = vi.hoisted(() => vi.fn());
vi.mock("@zcode/services/storage-startup", () => ({ resolveDefaultZCodeAgentCommand: resolver }));
import { prepareSessionStorage } from "../src/host/database-startup/storagePreparationProcesses.js";

it("uses a Host-owned Worker and waits for the preparation completion frame", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-worker-"));
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `
    const readline = require('node:readline');
    const { isMainThread } = require('node:worker_threads');
    if (isMainThread) process.exit(5);
    if (process.env.UWORK_SESSION_DB_MIGRATION !== '1') process.exit(7);
    const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
    const lines = readline.createInterface({ input: process.stdin });
    lines.once('line', () => {
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(0));
    });
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:cwd+'/relative.sqlite'}})+'\\n');
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const paths: string[] = [];
  try {
    await prepareSessionStorage({
      cwd: dir,
      signal: new AbortController().signal,
      report: () => {},
      observePath: async (path) => {
        paths.push(path);
      },
    });
    expect(paths).toEqual([dir + "/relative.sqlite"]);
    await writeFile(entry, "process.exit(0)");
    await expect(
      prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
      }),
    ).rejects.toThrow("transport_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "hands ownership to legacy migration and cleans its file after Worker exit (failure=%s)",
  async (fail) => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-ownership-"));
    const entry = join(dir, "prepare.cjs");
    const manifestPath = join(dir, "ownership.json");
    const resultPath = join(dir, "ack.json");
    const dbPath = join(dir, "new.sqlite");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
    await writeFile(join(dir, "old.sqlite"), "legacy fixture");
    await writeFile(
      entry,
      `
    const fs=require('node:fs');
    const send=frame=>process.stdout.write(JSON.stringify(frame)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
      const ack=JSON.parse(line);
      if (!ack.reuse && !fs.existsSync(ack.ownershipManifestPath)) process.exit(8);
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(ack));
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(${fail ? 2 : 0}));
    });
    send({method:'startup/storagePath',params:{path:${JSON.stringify(dbPath)},...(process.env.TEST_NO_LEGACY==='yes'?{}:{legacySourcePath:${JSON.stringify(join(dir, "old.sqlite"))}})}});
  `,
    );
    resolver.mockReturnValue({
      command: process.execPath,
      args: [],
      supportsStorageStartup: true,
      storagePreparationEntry: entry,
    });
    const dispose = vi.fn(async () => {
      await rm(manifestPath, { force: true });
    });
    const createOwnershipManifest = vi.fn(async () => ({ path: manifestPath, dispose }));
    const checkLegacyWriters = vi.fn(async () => {});
    try {
      const preparation = prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
        createOwnershipManifest,
        checkLegacyWriters,
      });
      if (fail) await expect(preparation).rejects.toThrow("transport_closed");
      else await preparation;
      expect(createOwnershipManifest).toHaveBeenCalledOnce();
      expect(checkLegacyWriters).toHaveBeenCalledWith(join(dir, "old.sqlite"));
      expect(dispose).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
        method: "startup/storagePathReady",
        reuse: false,
        ownershipManifestPath: manifestPath,
      });
      await expect(stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (!fail) {
        await prepareSessionStorage({
          cwd: dir,
          env: { TEST_NO_LEGACY: "yes" },
          signal: new AbortController().signal,
          report: () => {},
          observePath: async () => {},
          preparedPaths: new Set([dbPath]),
          createOwnershipManifest,
          checkLegacyWriters,
        });
        expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
          method: "startup/storagePathReady",
          reuse: true,
        });
        expect(createOwnershipManifest).toHaveBeenCalledOnce();
        expect(checkLegacyWriters).toHaveBeenCalledOnce();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("does not reuse an explicit database preparation as default-root migration completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-explicit-default-"));
  const target = join(dir, "target.sqlite");
  const legacy = join(dir, "legacy.sqlite");
  const entry = join(dir, "prepare.cjs");
  const ackFile = join(dir, "ack.json");
  const manifestPath = join(dir, "ownership.json");
  const database = new DatabaseSync(target);
  database.exec("PRAGMA user_version=0");
  database.close();
  await writeFile(legacy, "legacy fixture");
  await writeFile(
    entry,
    `
    const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');
    const legacy=process.env.TEST_PHASE==='legacy';
    require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
      const ack=JSON.parse(line);fs.writeFileSync(${JSON.stringify(ackFile)},JSON.stringify(ack));
      if(!ack.reuse){
        if(legacy&&!fs.existsSync(ack.ownershipManifestPath))process.exit(8);
        const db=new DatabaseSync(${JSON.stringify(target)});db.exec('PRAGMA user_version='+(legacy?2:1));db.close();
      }
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n',()=>process.exit(0));
    });
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(target)},...(legacy?{legacySourcePath:${JSON.stringify(legacy)}}:{})}})+'\\n');
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const createOwnershipManifest = vi.fn(async () => {
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
    return { path: manifestPath, dispose: () => rm(manifestPath, { force: true }) };
  });
  const checkLegacyWriters = vi.fn(async (_path: string) => {});
  const preparedPaths = new Set<string>();
  const prepare = (phase: string) =>
    prepareSessionStorage({
      cwd: dir,
      env: { TEST_PHASE: phase },
      signal: new AbortController().signal,
      report: () => {},
      observePath: async () => {},
      preparedPaths,
      createOwnershipManifest,
      checkLegacyWriters,
    });
  try {
    await prepare("explicit");
    expect(preparedPaths.has(await realpath(target))).toBe(true);
    expect(createOwnershipManifest).not.toHaveBeenCalled();
    await prepare("legacy");
    expect(JSON.parse(await readFile(ackFile, "utf8"))).toEqual({
      method: "startup/storagePathReady",
      reuse: false,
      ownershipManifestPath: manifestPath,
    });
    expect(createOwnershipManifest).toHaveBeenCalledOnce();
    expect(checkLegacyWriters.mock.calls.map(([path]) => path)).toEqual([legacy, target]);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  { padding: 65537, accepted: true },
  { padding: ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS + 1, accepted: false },
])(
  "enforces the shared control frame budget (accepted=$accepted)",
  async ({ padding, accepted }) => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-frame-budget-"));
    const entry = join(dir, "prepare.cjs");
    await writeFile(
      entry,
      `
    require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n',()=>process.exit(0));
    });
    process.stdout.write(' '.repeat(${padding})+JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(join(dir, "db.sqlite"))}}})+'\\n');
  `,
    );
    resolver.mockReturnValue({
      command: process.execPath,
      args: [],
      supportsStorageStartup: true,
      storagePreparationEntry: entry,
    });
    try {
      const preparation = prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
      });
      if (accepted) await preparation;
      else await expect(preparation).rejects.toThrow("transport_closed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("does not acknowledge migration when an existing target still has a possible writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-target-writer-"));
  const target = join(dir, "target.sqlite");
  const legacy = join(dir, "legacy.sqlite");
  const entry = join(dir, "prepare.cjs");
  await writeFile(target, "existing target");
  await writeFile(legacy, "legacy fixture");
  await writeFile(
    entry,
    `process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(target)},legacySourcePath:${JSON.stringify(legacy)}}})+'\\n');setInterval(()=>{},1000);`,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const createOwnershipManifest = vi.fn();
  const checkLegacyWriters = vi.fn(async (path: string) => {
    if (path === target)
      throw Object.assign(new Error("target writer active"), { kind: "legacy_writer_active" });
  });
  try {
    await expect(
      prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
        createOwnershipManifest,
        checkLegacyWriters,
      }),
    ).rejects.toMatchObject({ kind: "legacy_writer_active" });
    expect(checkLegacyWriters.mock.calls.map(([path]) => path)).toEqual([legacy, target]);
    expect(createOwnershipManifest).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "hands a fresh missing-source preparation a manifest while checking an existing target ($0)",
  async (targetPresent) => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-fresh-"));
    const source = join(dir, "missing-legacy.sqlite");
    const target = join(dir, "target.sqlite");
    const entry = join(dir, "prepare.cjs");
    const manifestPath = join(dir, "ownership.json");
    if (targetPresent) await writeFile(target, "existing target fixture");
    await writeFile(
      entry,
      `
    require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
      const ack=JSON.parse(line);
      if(!require('node:fs').existsSync(ack.ownershipManifestPath))process.exit(8);
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n',()=>process.exit(0));
    });
    process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(target)},legacySourcePath:${JSON.stringify(source)}}})+'\\n');
  `,
    );
    resolver.mockReturnValue({
      command: process.execPath,
      args: [],
      supportsStorageStartup: true,
      storagePreparationEntry: entry,
    });
    const checkLegacyWriters = vi.fn(async (path: string) => {
      if (path === source) throw new Error("must not query nonexistent files");
    });
    const createOwnershipManifest = vi.fn(async () => {
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
      return { path: manifestPath, dispose: () => rm(manifestPath, { force: true }) };
    });
    try {
      await prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
        createOwnershipManifest,
        checkLegacyWriters,
      });
      expect(checkLegacyWriters.mock.calls.map(([path]) => path)).toEqual(
        targetPresent ? [target] : [],
      );
      expect(createOwnershipManifest).toHaveBeenCalledOnce();
      await expect(stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  { scope: "source", kind: "file" },
  { scope: "source", kind: "ancestor" },
  { scope: "target", kind: "file" },
  { scope: "target", kind: "ancestor" },
])("does not treat a broken $scope $kind symlink as a fresh install", async ({ scope, kind }) => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-broken-source-"));
  const broken =
    kind === "file" ? join(dir, "broken.sqlite") : join(dir, "offline-root", "broken.sqlite");
  await symlink(
    join(dir, "offline"),
    kind === "file" ? broken : join(dir, "offline-root"),
    kind === "file" ? "file" : "dir",
  );
  const source = scope === "source" ? broken : join(dir, "source.sqlite");
  const target = scope === "target" ? broken : join(dir, "target.sqlite");
  if (scope === "target") await writeFile(source, "legacy fixture");
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(target)},legacySourcePath:${JSON.stringify(source)}}})+'\\n');setInterval(()=>{},1000);`,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const createOwnershipManifest = vi.fn();
  try {
    await expect(
      prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        report: () => {},
        observePath: async () => {},
        createOwnershipManifest,
        checkLegacyWriters: async () => {},
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(createOwnershipManifest).not.toHaveBeenCalled();
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("cleans a manifest that finishes asynchronously after Worker abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-preparation-late-manifest-"));
  const entry = join(dir, "prepare.cjs");
  const manifestPath = join(dir, "ownership.json");
  await writeFile(join(dir, "old.sqlite"), "legacy fixture");
  await writeFile(
    entry,
    `process.stdout.write(JSON.stringify({method:'startup/storagePath',params:{path:${JSON.stringify(join(dir, "new.sqlite"))},legacySourcePath:${JSON.stringify(join(dir, "old.sqlite"))}}})+'\\n');setInterval(()=>{},1000);`,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const abort = new AbortController();
  let startManifest!: () => void;
  let finishManifest!: () => void;
  const started = new Promise<void>((resolve) => {
    startManifest = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finishManifest = resolve;
  });
  const dispose = vi.fn(async () => {
    await rm(manifestPath, { force: true });
  });
  const operation = prepareSessionStorage({
    cwd: dir,
    signal: abort.signal,
    report: () => {},
    observePath: async () => {},
    checkLegacyWriters: async () => {},
    createOwnershipManifest: async () => {
      startManifest();
      await finished;
      await writeFile(manifestPath, "private ownership");
      return { path: manifestPath, dispose };
    },
  });
  const rejection = expect(operation).rejects.toThrow("transport_closed");
  try {
    await started;
    abort.abort();
    finishManifest();
    await rejection;
    expect(dispose).toHaveBeenCalledOnce();
    await expect(stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    finishManifest();
    abort.abort();
    await rm(dir, { recursive: true, force: true });
  }
});

it("SILENTDB-06: reuses only successful paths in this attempt and keeps different databases separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-preparation-dedup-"));
  const entry = join(dir, "prepare.cjs");
  await writeFile(
    entry,
    `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    const path = process.env.TEST_DB_PATH;
    const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
    lines.once('line', line => {
      const reuse = JSON.parse(line).reuse;
      if (!reuse) send({method:'startup/storageState',params:{schemaVersion:1,attemptId:'attempt',sequence:1,databaseId:'db',databaseKind:'session',phase:'checking',elapsedMs:0}});
      process.stdout.write(JSON.stringify({method:'startup/storagePrepared',params:{}})+'\\n', () => process.exit(process.env.TEST_FAIL === 'yes' ? 1 : 0));
    });
    send({method:'startup/storagePath',params:{path}});
  `,
  );
  resolver.mockReturnValue({
    command: process.execPath,
    args: [],
    supportsStorageStartup: true,
    storagePreparationEntry: entry,
  });
  const preparedPaths = new Set<string>();
  const report = vi.fn();
  const observePath = vi.fn(async () => {});
  const prepare = (name: string, fail = false) =>
    prepareSessionStorage({
      cwd: dir,
      env: { TEST_DB_PATH: join(dir, name), TEST_FAIL: fail ? "yes" : "no" },
      signal: new AbortController().signal,
      report,
      observePath,
      preparedPaths,
    });
  try {
    await prepare("shared.sqlite");
    await prepare("shared.sqlite");
    expect(observePath).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    await prepare("other.sqlite");
    expect(observePath).toHaveBeenCalledTimes(2);
    await expect(prepare("failed.sqlite", true)).rejects.toThrow("transport_closed");
    expect(preparedPaths.has(join(dir, "failed.sqlite"))).toBe(false);
    await prepare("failed.sqlite");
    expect(observePath).toHaveBeenCalledTimes(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
