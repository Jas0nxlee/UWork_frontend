import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}
type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;
export type LegacySessionWriterInventory = (sourcePath: string) => Promise<readonly number[]>;

const runCommand: CommandRunner = (file, args) =>
  new Promise((resolveCommand, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolveCommand({ stdout, stderr, code: (error?.code as number) ?? 0 });
      },
    );
  });

const isCliCandidate = (command: string) =>
  /(?:^|[\\/\s])(?:uwork-cli|zcode-cli)(?:\s|$)/i.test(command) ||
  /zcode\.cjs[\s\S]*\bapp-server\b/i.test(command);

function unknownInventory(): Error {
  return Object.assign(new Error("Cannot verify legacy session database writers"), {
    kind: "legacy_writer_check_failed",
    code: "UWORK_LEGACY_WRITER_CHECK_FAILED",
  });
}

async function existingSourcePaths(sourcePath: string): Promise<string[]> {
  const source = await realpath(sourcePath);
  const paths = new Set([source]);
  for (const databasePath of new Set([sourcePath, source])) {
    try {
      paths.add(await realpath(`${databasePath}-wal`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...paths];
}

/** 只读保守检查：无法排除的 CLI 持有者阻止迁移，不向任何现有进程发送信号。 */
export async function assertNoLegacySessionWriters(
  sourcePath: string,
  inventory: LegacySessionWriterInventory = collectLegacySessionWriters,
): Promise<void> {
  let pids: readonly number[];
  try {
    pids = await inventory(sourcePath);
    if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) throw unknownInventory();
  } catch {
    throw unknownInventory();
  }
  if (pids.some((pid) => pid !== process.pid))
    throw Object.assign(
      new Error("Close existing CLI writers before retrying session database migration"),
      {
        kind: "legacy_writer_active",
        code: "UWORK_LEGACY_WRITER_ACTIVE",
      },
    );
}

/** inventory 注入仅供平台测试；实际调用使用 OS 打开的文件事实，不能用归属清单替代。 */
export async function collectLegacySessionWriters(
  sourcePath: string,
  options: {
    platform?: NodeJS.Platform;
    run?: CommandRunner;
    procRoot?: string;
    uid?: number;
    includeAllHolders?: boolean;
  } = {},
): Promise<number[]> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  if (platform === "darwin") {
    const files = await existingSourcePaths(sourcePath);
    const holders = await run("lsof", ["-t", "--", ...files]);
    if (holders.stderr.trim() || (holders.code !== 0 && holders.code !== 1))
      throw unknownInventory();
    const pids = [...new Set(holders.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
    if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw unknownInventory();
    const others = pids.filter((pid) => pid !== process.pid);
    if (!others.length) return [];
    if (options.includeAllHolders) return others;
    const processes = await run("ps", ["-p", others.join(","), "-o", "pid=,comm=,args="]);
    if (processes.stderr.trim() || (processes.code !== 0 && processes.code !== 1))
      throw unknownInventory();
    const result: number[] = [];
    for (const line of processes.stdout.split("\n").filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) throw unknownInventory();
      if (others.includes(Number(match[1])) && isCliCandidate(match[2]!))
        result.push(Number(match[1]));
    }
    return result;
  }
  if (platform === "linux") {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw unknownInventory();
    const sources = new Set(
      await Promise.all(
        (await existingSourcePaths(sourcePath)).map(async (path) => {
          const info = await stat(path, { bigint: true });
          return `${info.dev}:${info.ino}`;
        }),
      ),
    );
    const root = options.procRoot ?? "/proc";
    const result: number[] = [];
    for (const name of await readdir(root)) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const processRoot = join(root, name);
      try {
        if ((await stat(processRoot)).uid !== uid) continue;
        const [comm, cmdline] = await Promise.all([
          readFile(join(processRoot, "comm"), "utf8"),
          readFile(join(processRoot, "cmdline"), "utf8"),
        ]);
        if (
          !options.includeAllHolders &&
          !isCliCandidate(`${comm.trim()} ${cmdline.split("\0").join(" ")}`)
        )
          continue;
        for (const fd of await readdir(join(processRoot, "fd"))) {
          let identity: string;
          try {
            // realpath 不能合并硬链接；旧写者经另一显式路径打开同库时会被漏掉。
            // 直接跟随 proc FD 读取精确设备/inode，已 unlink 但仍打开的 FD 也保留真实身份。
            const info = await stat(join(processRoot, "fd", fd), { bigint: true });
            identity = `${info.dev}:${info.ino}`;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (sources.has(identity)) {
            result.push(Number(name));
            break;
          }
        }
      } catch (error) {
        // 进程/FD 正常退出可忽略；权限不明不能被当成“没有写者”。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return result;
  }
  if (platform === "win32") {
    // Windows 的 CIM Name 是可执行映像，不随 process.title 改名；原生 fallback 仍叫 zcode-agent.exe。
    // 遗漏该受支持入口会放过还在写旧库的原生 app-server，不能只检测 zcode.cjs。
    const script = `$ErrorActionPreference='Stop'; $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $items=@(); Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(UWork|zcode|electron|node)' -or $_.CommandLine -match 'zcode\\.cjs' } | ForEach-Object { $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner; if ($owner.ReturnValue -ne 0) { throw 'owner unavailable' }; if (($owner.Domain+'\\'+$owner.User) -eq $current) { if (!$_.CommandLine) { throw 'command unavailable' }; if ((($_.CommandLine -match 'zcode\\.cjs' -or $_.Name -match '^(uwork-cli|zcode-cli|zcode-agent|zcode)(\\.exe)?$') -and $_.CommandLine -match 'app-server') -or (${options.includeAllHolders ? "$true" : "$false"} -and (($_.Name -match '^(UWork|zcode)' -and $_.CommandLine -match 'node\\.mojom\\.NodeService') -or $_.CommandLine -match '(uwork|zcode).*([\\/]host[\\/]|[\\/]scheduler[\\/]|source-server)'))) { $items += [pscustomobject]@{pid=$_.ProcessId} } } }; ConvertTo-Json -InputObject @($items) -Compress`;
    const output = await run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    if (output.code !== 0 || output.stderr.trim()) throw unknownInventory();
    const rows: unknown = JSON.parse(output.stdout);
    if (!Array.isArray(rows)) throw unknownInventory();
    return rows
      .map((row: unknown) => {
        const pid = (row as { pid?: unknown })?.pid;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
          throw unknownInventory();
        return pid;
      })
      .filter((pid) => pid !== process.pid);
  }
  throw unknownInventory();
}
