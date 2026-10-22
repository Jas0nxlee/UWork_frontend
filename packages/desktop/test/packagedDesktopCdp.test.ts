import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  captureProcessTreeSnapshot,
  terminateProcessTreeAndWait,
} from "@zcode/services/process/processTreeTerminator";
import {
  launchPackagedDesktopCdp,
  stopOwnedDesktopProcess,
} from "../scripts/packaged-desktop-cdp.mjs";

const fixture = vi.hoisted(() => ({
  executable: "",
  child: null as ChildProcess | null,
  connect: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (args[0] === fixture.executable) fixture.child = child;
      return child;
    },
  };
});
vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: fixture.connect },
}));

it.skipIf(process.platform === "win32")(
  "retains ownership of a detached descendant when CDP closes the root first",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "packaged-cdp-owner-"));
    const stateFile = join(directory, "state.json");
    fixture.executable = join(directory, "desktop.mjs");
    await writeFile(
      fixture.executable,
      `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
await writeFile(${JSON.stringify(stateFile)},JSON.stringify({descendantPid:child.pid}));
console.error('DevTools listening on ws://127.0.0.1:12345/fixture');
setInterval(()=>{},1000);
`,
    );
    await chmod(fixture.executable, 0o755);
    let snapshot: ReturnType<typeof captureProcessTreeSnapshot>;
    fixture.connect.mockImplementation(async () => {
      snapshot = captureProcessTreeSnapshot(fixture.child!);
      return {
        close: async () => {
          const exited = once(fixture.child!, "exit");
          fixture.child!.kill("SIGTERM");
          await exited;
        },
      };
    });
    try {
      const app = await launchPackagedDesktopCdp({
        executablePath: fixture.executable,
        env: process.env,
        platform: "mac",
      });
      const { descendantPid } = JSON.parse(await readFile(stateFile, "utf8"));
      expect(snapshot!.identities.some((identity) => identity.pid === descendantPid)).toBe(true);
      await app.close();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      if (fixture.child && snapshot) {
        await terminateProcessTreeAndWait(fixture.child, {
          snapshot,
          forceAfterMs: 100,
          waitAfterForceMs: 1000,
        });
        fixture.child.stdout?.destroy();
        fixture.child.stderr?.destroy();
      }
      fixture.executable = "";
      fixture.child = null;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("terminates only the test-owned process and keeps a separate process alive", async () => {
  const start = () =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
  const owned = start();
  const other = start();
  try {
    await stopOwnedDesktopProcess(owned);
    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    expect(other.exitCode).toBeNull();
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
  } finally {
    await stopOwnedDesktopProcess(owned);
    await stopOwnedDesktopProcess(other);
  }
});
