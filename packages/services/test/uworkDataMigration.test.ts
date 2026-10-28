import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { copyDataDirectory, listDataDirectorySqliteFiles, setDataBaseDir } from "../src/paths.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "uwork-migration-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("migration retains all UWork state and relocates metadata without copying bootstrap or upstream", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    const files = {
      "v2/credentials.json": '{"fixture":true}',
      "v2/setting.json": '{"dataBaseDir":"old"}',
      "cli/config.json":
        '{"mcp":{"servers":{"fixture":{"enabled":false,"command":"fixture"}}},"plugins":{"enabledPlugins":{"fixture@personal":false}}}',
      "skills/demo/SKILL.md": "fixture skill",
      "commands/demo.md": "fixture command",
      "workflows/demo.md": "fixture workflow",
      "plugins/demo/plugin.json": JSON.stringify({ path: join(old, ".uwork", "skills", "demo") }),
      "plugins/installed_plugins.json": JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "demo",
            name: "demo",
            marketplace: "fixture",
            scope: "user",
            version: "1.0.0",
            installedAt: "2026-10-28",
            installPath: join(old, ".uwork", "plugins", "demo"),
            description: join(old, ".uwork", "user-text"),
          },
        ],
      }),
    };
    for (const [name, data] of Object.entries(files)) {
      const path = join(old, ".uwork", name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, data);
    }
    await mkdir(join(old, ".zcode"));
    await writeFile(join(old, ".zcode", "private"), "unchanged");
    await copyDataDirectory(old, next);
    for (const [name, data] of Object.entries(files)) {
      if (name === "v2/setting.json" || name === "plugins/installed_plugins.json") continue;
      assert.equal(await readFile(join(next, ".uwork", name), "utf8"), data);
    }
    assert.equal(
      JSON.parse(await readFile(join(next, ".uwork", "plugins/installed_plugins.json"), "utf8"))
        .plugins[0].installPath,
      join(next, ".uwork", "plugins", "demo"),
    );
    await assert.rejects(readFile(join(next, ".uwork", "v2/setting.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(next, ".zcode", "private")), { code: "ENOENT" });
    assert.equal(await readFile(join(old, ".zcode", "private"), "utf8"), "unchanged");
  }));

test("migration ignores an existing upstream v2 tree and retains UWork state", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    await mkdir(join(old, ".uwork", "v2"), { recursive: true });
    await writeFile(join(old, ".uwork", "v2", "tasks.json"), '{"uwork":true}');
    await mkdir(join(old, ".zcode", "v2"), { recursive: true });
    await writeFile(join(old, ".zcode", "v2", "tasks.json"), '{"upstream":true}');

    await copyDataDirectory(old, next);

    assert.equal(
      await readFile(join(next, ".uwork", "v2", "tasks.json"), "utf8"),
      '{"uwork":true}',
    );
    assert.equal(await readFile(join(old, ".uwork", "v2", "tasks.json"), "utf8"), '{"uwork":true}');
    assert.equal(
      await readFile(join(old, ".zcode", "v2", "tasks.json"), "utf8"),
      '{"upstream":true}',
    );
    await assert.rejects(readFile(join(next, ".zcode", "v2", "tasks.json")), { code: "ENOENT" });
  }));

test("target conflicts and copy failures preserve old state without migration residue", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "old");
    await mkdir(join(next, ".uwork"), { recursive: true });
    await writeFile(join(next, ".uwork", "state"), "target");
    await assert.rejects(copyDataDirectory(old, next), /not empty/);
    assert.equal(await readFile(join(next, ".uwork", "state"), "utf8"), "target");
    await rm(join(next, ".uwork"), { recursive: true });
    await assert.rejects(copyDataDirectory(join(root, "missing"), next), { code: "ENOENT" });
    assert.deepEqual(await readdir(next), []);
    assert.equal(await readFile(join(old, ".uwork", "state"), "utf8"), "old");
  }));

test("migration preserves disabled user skill and command path keys without rewriting arbitrary keys", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    const skill = join(old, ".uwork", "skills", "demo", "SKILL.md");
    const command = join(old, ".uwork", "commands", "demo.md");
    const unrelated = join(root, "workspace", "SKILL.md");
    await mkdir(join(old, ".uwork", "cli"), { recursive: true });
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "---\nname: demo\ndescription: fixture\n---\nfixture");
    await mkdir(join(command, ".."), { recursive: true });
    await writeFile(command, "fixture command");
    await writeFile(
      join(old, ".uwork", "cli", "config.json"),
      JSON.stringify({
        skills: {
          [skill.replaceAll("\\", "/")]: { enable: false },
          [unrelated]: { enable: false },
        },
        command: { [command]: { enable: false } },
        custom: { [skill]: "ordinary key" },
      }),
    );
    await copyDataDirectory(old, next);
    const migrated = JSON.parse(await readFile(join(next, ".uwork", "cli", "config.json"), "utf8"));
    const canonicalSkill = await realpath(join(next, ".uwork", "skills", "demo", "SKILL.md"));
    assert.equal(migrated.skills[canonicalSkill.replaceAll("\\", "/")].enable, false);
    assert.equal(migrated.command[join(next, ".uwork", "commands", "demo.md")].enable, false);
    assert.equal(migrated.skills[unrelated].enable, false);
    assert.equal(migrated.custom[skill], "ordinary key");
    assert.equal(migrated.skills[skill], undefined);
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    setDataBaseDir(next);
    try {
      const { createSkillsService } = await import("../src/skills/skillsService.js");
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const listing = await createSkillsService({ isDesktopRuntime: true }).list({ workspacePath });
      const restored = listing.skills.find((item) => item.path === canonicalSkill);
      assert.ok(restored, "relocated user skill must be visible after reader restart");
      assert.equal(restored.enabled, false, "disabled state must remain disabled");
    } finally {
      setDataBaseDir(null);
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  }));

test("Windows normalized skill keys and native command keys retain disabled overrides", async () => {
  const { relocateCliPathOverrides } = await import("../src/dataDirectoryMigrationMetadata.js");
  const config = {
    skills: { "C:/old/.uwork/skills/demo/SKILL.md": { enable: false } },
    command: { "C:\\old\\.uwork\\commands\\demo.md": { enable: false } },
    custom: { "C:/old/.uwork/skills/demo/SKILL.md": "ordinary" },
  };
  relocateCliPathOverrides(config, {
    source: "C:\\old\\.uwork",
    target: "D:\\new\\.uwork",
    canonicalSource: "C:\\old\\.uwork",
    canonicalTarget: "D:\\new\\.uwork",
  });
  assert.deepEqual(config.skills, { "D:/new/.uwork/skills/demo/SKILL.md": { enable: false } });
  assert.deepEqual(config.command, { "D:\\new\\.uwork\\commands\\demo.md": { enable: false } });
  assert.equal(config.custom["C:/old/.uwork/skills/demo/SKILL.md"], "ordinary");
});

test("cold copy snapshots committed WAL contents and leaves no copied SQLite sidecars", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    const sourcePath = join(old, ".uwork", "cli", "db", "db.sqlite");
    await mkdir(join(sourcePath, ".."), { recursive: true });
    const db = new DatabaseSync(sourcePath);
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO facts VALUES(1,'committed-in-wal')",
      );
      await copyDataDirectory(old, next, { requestId: "cold-wal" });
      const targetPath = join(next, ".uwork", "cli", "db", "db.sqlite");
      await assert.rejects(stat(`${targetPath}-wal`), { code: "ENOENT" });
      await assert.rejects(stat(`${targetPath}-shm`), { code: "ENOENT" });
      const copied = new DatabaseSync(targetPath, { readOnly: true });
      try {
        assert.deepEqual(
          copied
            .prepare("SELECT text FROM facts")
            .all()
            .map((row) => row.text),
          ["committed-in-wal"],
        );
      } finally {
        copied.close();
      }
      assert.equal(db.prepare("SELECT count(*) AS n FROM facts").get()?.n, 1);
    } finally {
      db.close();
    }
  }));

test("request receipts resume an activated copy without copying or reading the old root again", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "original");
    await copyDataDirectory(old, next, { requestId: "activated-request" });
    const receiptPath = join(next, ".uwork", ".uwork-data-migration-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.requestId, "activated-request");
    if (process.platform !== "win32") assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
    await rm(join(old, ".uwork"), { recursive: true });
    await copyDataDirectory(old, next, { requestId: "activated-request" });
    assert.equal(await readFile(join(next, ".uwork", "state"), "utf8"), "original");
    await assert.rejects(
      copyDataDirectory(old, next, { requestId: "other-request" }),
      /receipt|request|not empty/i,
    );
    await assert.rejects(copyDataDirectory(old, next), /not empty/i);
  }));

test("receipt replay refuses changed contents or a malformed receipt without overwriting target", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "original");
    await copyDataDirectory(old, next, { requestId: "unchanged-only" });
    const targetState = join(next, ".uwork", "state");
    await writeFile(targetState, "changed-after-activation");
    await assert.rejects(
      copyDataDirectory(old, next, { requestId: "unchanged-only" }),
      /receipt|verification|fingerprint/i,
    );
    assert.equal(await readFile(targetState, "utf8"), "changed-after-activation");
    await writeFile(join(next, ".uwork", ".uwork-data-migration-receipt.json"), "{broken");
    await assert.rejects(copyDataDirectory(old, next, { requestId: "unchanged-only" }));
    assert.equal(await readFile(targetState, "utf8"), "changed-after-activation");
  }));

test("a failed real SQLite snapshot never publishes the target", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(
      join(old, ".uwork", "broken.sqlite"),
      Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(128)]),
    );
    await assert.rejects(copyDataDirectory(old, next, { requestId: "invalid-snapshot" }));
    await assert.rejects(stat(join(next, ".uwork")), { code: "ENOENT" });
    assert.deepEqual(await readdir(next), []);
    assert.equal((await stat(join(old, ".uwork", "broken.sqlite"))).size, 144);
  }));

test("resetToDefault preserves only the explicitly designated bootstrap owner and excludes its future CAS changes", async () =>
  fixture(async (root) => {
    const old = join(root, "custom"),
      next = join(root, "home");
    const owner = join(next, ".uwork", "v2", "setting.json");
    const original = '{"dataBaseDir":"custom","pending":"reset-request"}\n';
    await mkdir(join(old, ".uwork", "v2"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "business");
    await writeFile(join(old, ".uwork", "v2", "setting.json"), "source-is-not-the-owner");
    await mkdir(join(owner, ".."), { recursive: true });
    await writeFile(owner, original, { mode: 0o600 });
    await assert.rejects(
      copyDataDirectory(old, next, { requestId: "without-owner-exception" }),
      /not empty/,
    );
    const options = { requestId: "reset-request", bootstrapSettingsFilePath: owner };
    await copyDataDirectory(old, next, options);
    assert.equal(await readFile(owner, "utf8"), original);
    assert.equal(await readFile(join(next, ".uwork", "state"), "utf8"), "business");
    await writeFile(owner, '{"dataBaseDir":null}');
    await copyDataDirectory(old, next, options);
    assert.equal(await readFile(owner, "utf8"), '{"dataBaseDir":null}');
    await writeFile(join(next, ".uwork", "foreign-file"), "do-not-overwrite");
    await assert.rejects(copyDataDirectory(old, next, options), /receipt|verification/);
    assert.equal(await readFile(join(next, ".uwork", "foreign-file"), "utf8"), "do-not-overwrite");
  }));

test("resetToDefault resumes a real partial-retire crash using the external request instead of rebuilding target", async () =>
  fixture(async (root) => {
    const old = join(root, "custom"),
      next = join(root, "home");
    const target = join(next, ".uwork");
    const owner = join(target, "v2", "setting.json");
    const original = '{"dataBaseDir":"custom","pending":"retire-request"}';
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "retained-business");
    await mkdir(join(owner, ".."), { recursive: true });
    await writeFile(owner, original, { mode: 0o600 });
    // 模拟C owner在产品根外已持久化的请求/原bootstrap字节，恢复时不先重建target。
    const recovery = join(next, ".external-recovery.json");
    await writeFile(
      recovery,
      JSON.stringify({ requestId: "retire-request", bootstrap: original }),
      { mode: 0o600 },
    );
    const options = { requestId: "retire-request", bootstrapSettingsFilePath: owner };
    const originalRename = fsPromises.rename;
    let injected = false;
    const replacement = mock.method(fsPromises, "rename", async (from, to) => {
      await originalRename(from, to);
      if (String(from) === target && String(to).endsWith("retired-bootstrap")) {
        injected = true;
        throw new Error("simulated crash after bootstrap retire");
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(copyDataDirectory(old, next, options), /simulated crash/);
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    await assert.rejects(stat(owner), { code: "ENOENT" });
    const external = JSON.parse(await readFile(recovery, "utf8"));
    assert.equal(external.bootstrap, original);
    await copyDataDirectory(old, next, options);
    assert.equal(await readFile(owner, "utf8"), original);
    assert.equal(await readFile(join(target, "state"), "utf8"), "retained-business");
    assert.equal(await readFile(join(old, ".uwork", "state"), "utf8"), "retained-business");
  }));

test("SQLite enumeration uses headers, including extensionless databases, without opening plain .db files", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "next");
    await mkdir(join(old, ".uwork"), { recursive: true });
    const sqlite = join(old, ".uwork", "without-extension");
    const db = new DatabaseSync(sqlite);
    db.exec("CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES('retained')");
    db.close();
    await writeFile(join(old, ".uwork", "ordinary.db"), "not a SQLite database");
    assert.deepEqual(await listDataDirectorySqliteFiles(old), [sqlite]);
    await copyDataDirectory(old, next, { requestId: "header-based" });
    assert.equal(
      await readFile(join(next, ".uwork", "ordinary.db"), "utf8"),
      "not a SQLite database",
    );
  }));

test("default database symlinks fail closed instead of publishing a root without history", async () =>
  fixture(async (root) => {
    if (process.platform === "win32") return;
    const old = join(root, "old"),
      next = join(root, "next");
    const external = join(root, "external.sqlite");
    const db = new DatabaseSync(external);
    db.exec("CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES('external')");
    db.close();
    const path = join(old, ".uwork", "cli", "db", "db.sqlite");
    await mkdir(join(path, ".."), { recursive: true });
    await symlink(external, path);
    await assert.rejects(listDataDirectorySqliteFiles(old), /linked SQLite/);
    await assert.rejects(
      copyDataDirectory(old, next, { requestId: "linked-default" }),
      /linked SQLite/,
    );
    await assert.rejects(stat(join(next, ".uwork")), { code: "ENOENT" });
    const source = new DatabaseSync(external, { readOnly: true });
    try {
      assert.equal(source.prepare("SELECT value FROM facts").get()?.value, "external");
    } finally {
      source.close();
    }
  }));

test("a known application database with a damaged header is never copied as an ordinary file", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "next");
    const path = join(old, ".uwork", "v2", "tasks-index.sqlite");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "damaged SQLite header");
    await assert.rejects(
      copyDataDirectory(old, next, { requestId: "damaged-header" }),
      /SQLite.*header|snapshot/i,
    );
    await assert.rejects(stat(join(next, ".uwork")), { code: "ENOENT" });
  }));

test("business JSON, immutable session cwd/identity and user text stay byte-for-byte unchanged", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "next");
    const source = join(old, ".uwork");
    const legacy =
      JSON.stringify(
        {
          workspacePath: join(source, "workspace", "task"),
          workspaceIdentity: join(source, "workspace", "task"),
          text: join(source, "user-authored-text"),
          nested: { path: join(source, "project") },
        },
        null,
        4,
      ) + "\n";
    for (const local of ["v2/sessions/history.json", "plugins/arbitrary/plugin.json"]) {
      await mkdir(join(source, local, ".."), { recursive: true });
      await writeFile(join(source, local), legacy);
    }
    await mkdir(join(source, "cli"), { recursive: true });
    await writeFile(
      join(source, "cli", "config.json"),
      JSON.stringify({ storage: { dir: source }, notes: join(source, "keep-this-user-text") }),
    );
    await copyDataDirectory(old, next, { requestId: "byte-preserving" });
    for (const local of ["v2/sessions/history.json", "plugins/arbitrary/plugin.json"])
      assert.equal(await readFile(join(next, ".uwork", local), "utf8"), legacy);
    const config = JSON.parse(await readFile(join(next, ".uwork", "cli", "config.json"), "utf8"));
    assert.equal(config.storage.dir, join(next, ".uwork"));
    assert.equal(config.notes, join(source, "keep-this-user-text"));
  }));

test("bootstrap filename prefixes never exempt directories or their descendants from verification", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "home");
    const target = join(next, ".uwork");
    const owner = join(target, "v2", "setting.json");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "business");
    await mkdir(join(owner, ".."), { recursive: true });
    await writeFile(owner, "{}", { mode: 0o600 });
    const hidden = join(target, "v2", "setting.json.tmp-123-456-abcdef", "hidden");
    await mkdir(join(hidden, ".."), { recursive: true });
    await writeFile(hidden, "foreign");
    const options = { requestId: "no-directory-exclusion", bootstrapSettingsFilePath: owner };
    await assert.rejects(copyDataDirectory(old, next, options), /not empty/);
    assert.equal(await readFile(hidden, "utf8"), "foreign");
    await rm(join(hidden, ".."), { recursive: true });
    await copyDataDirectory(old, next, options);
    await mkdir(join(hidden, ".."), { recursive: true });
    await writeFile(hidden, "new-foreign");
    await assert.rejects(copyDataDirectory(old, next, options), /receipt|verification/);
  }));

test("staging flushes regular files through writable handles before restoring readonly source modes", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "next");
    const source = join(old, ".uwork");
    await mkdir(join(source, "cli"), { recursive: true });
    const sqlite = join(source, "a.sqlite");
    const db = new DatabaseSync(sqlite);
    db.exec("CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES('snapshot')");
    db.close();
    const config = join(source, "cli", "config.json");
    await writeFile(config, JSON.stringify({ storage: { dir: source } }));
    await fsPromises.chmod(sqlite, 0o444);
    await fsPromises.chmod(config, 0o444);
    const originalOpen = fsPromises.open;
    let readonlyFlushes = 0;
    const replacement = mock.method(fsPromises, "open", async (path, flags, mode) => {
      const file = await originalOpen(path, flags, mode);
      const info = await file.stat();
      const originalSync = file.sync.bind(file);
      file.sync = async () => {
        if (info.isFile() && !/[wa+]/.test(String(flags))) {
          readonlyFlushes += 1;
          throw new Error("simulated Windows flush requires a writable handle");
        }
        return originalSync();
      };
      return file;
    });
    syncBuiltinESMExports();
    try {
      await copyDataDirectory(old, next, { requestId: "writable-flush" });
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(readonlyFlushes, 0);
    const migratedConfig = JSON.parse(
      await readFile(join(next, ".uwork", "cli", "config.json"), "utf8"),
    );
    assert.equal(migratedConfig.storage.dir, join(next, ".uwork"));
    if (process.platform !== "win32") {
      assert.equal((await stat(join(next, ".uwork", "a.sqlite"))).mode & 0o777, 0o444);
      assert.equal((await stat(join(next, ".uwork", "cli", "config.json"))).mode & 0o777, 0o444);
    }
  }));

test("project-level disabled keys below the retained workspace cwd do not move with user asset keys", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "next");
    const source = join(old, ".uwork");
    const userSkill = join(source, "skills", "personal", "SKILL.md");
    const projectSkill = join(
      source,
      "workspace",
      "task",
      ".zcode",
      "skills",
      "project",
      "SKILL.md",
    );
    const projectCommand = join(source, "workspace", "task", ".zcode", "commands", "project.md");
    await mkdir(join(source, "cli"), { recursive: true });
    for (const path of [userSkill, projectSkill, projectCommand]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "fixture");
    }
    await writeFile(
      join(source, "cli", "config.json"),
      JSON.stringify({
        skills: { [userSkill]: { enable: false }, [projectSkill]: { enable: false } },
        command: { [projectCommand]: { enable: false } },
      }),
    );
    await copyDataDirectory(old, next, { requestId: "immutable-cwd-keys" });
    const config = JSON.parse(await readFile(join(next, ".uwork", "cli", "config.json"), "utf8"));
    const migratedUserSkill = (
      await realpath(join(next, ".uwork", "skills", "personal", "SKILL.md"))
    ).replaceAll("\\", "/");
    assert.deepEqual(config.skills[migratedUserSkill], {
      enable: false,
    });
    assert.deepEqual(config.skills[projectSkill], { enable: false });
    assert.deepEqual(config.command[projectCommand], { enable: false });
    assert.equal(
      config.skills[
        join(next, ".uwork", "workspace", "task", ".zcode", "skills", "project", "SKILL.md")
      ],
      undefined,
    );
  }));

test("foreign nonempty directory conflicts expose a stable structured startup code", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "next");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await mkdir(join(next, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "source"), "source");
    await writeFile(join(next, ".uwork", "foreign"), "preserved");
    await assert.rejects(copyDataDirectory(old, next, { requestId: "coded-conflict" }), {
      code: "DATA_DIRECTORY_TARGET_CONFLICT",
    });
    assert.equal(await readFile(join(next, ".uwork", "foreign"), "utf8"), "preserved");
  }));
