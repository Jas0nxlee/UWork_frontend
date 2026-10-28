/** 仅 CLI 契约规定的技能/命令启停映射以路径作键，普通 JSON 键不能泛化迁移。 */
export function relocateCliPathOverrides(
  config: Record<string, unknown>,
  roots: {
    source: string;
    target: string;
    canonicalSource: string;
    canonicalTarget: string;
  },
): void {
  for (const field of ["skills", "command"]) {
    const map = config[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const relocated: Record<string, unknown> = {};
    for (const [key, state] of Object.entries(map)) {
      // workspace 副本不是旧会话 cwd；项目级禁用键必须继续命中旧目录。
      const mappings = isOwnedAssetPath(key, roots)
        ? [
            [roots.source, roots.target],
            [roots.canonicalSource, roots.canonicalTarget],
          ]
        : [];
      let nextKey = key;
      for (const [oldRoot, newRoot] of mappings) {
        const normalized = key.replaceAll("\\", "/");
        const prefix = oldRoot!.replaceAll("\\", "/");
        const comparable = /^[A-Za-z]:\//u.test(prefix) ? normalized.toLowerCase() : normalized;
        const parent = /^[A-Za-z]:\//u.test(prefix) ? prefix.toLowerCase() : prefix;
        if (comparable !== parent && !comparable.startsWith(`${parent}/`)) continue;
        const target = field === "skills" ? roots.canonicalTarget : newRoot!;
        const separator = field === "skills" || key.includes("/") ? "/" : "\\";
        nextKey =
          target.replaceAll("\\", separator) +
          normalized.slice(prefix.length).replaceAll("/", separator);
        break;
      }
      if (Object.hasOwn(relocated, nextKey))
        throw new Error("UWork migration path override collision");
      relocated[nextKey] = state;
    }
    config[field] = relocated;
  }
}

type MigrationRoots = Parameters<typeof relocateCliPathOverrides>[1];
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isOwnedAssetPath(value: string, roots: MigrationRoots): boolean {
  const normalized = value.replaceAll("\\", "/");
  for (const source of [roots.source, roots.canonicalSource]) {
    const prefix = source.replaceAll("\\", "/");
    const windows = /^[A-Za-z]:\//.test(prefix);
    const comparable = windows ? normalized.toLowerCase() : normalized;
    const parent = windows ? prefix.toLowerCase() : prefix;
    if (!comparable.startsWith(`${parent}/`)) continue;
    return /^(?:skills|commands|agents|plugins|cli\/plugins)(?:\/|$)/.test(
      comparable.slice(parent.length + 1),
    );
  }
  return false;
}
function relocateStoragePath(value: string, roots: MigrationRoots): string {
  const normalized = value.replaceAll("\\", "/");
  for (const [source, target] of [
    [roots.source, roots.target],
    [roots.canonicalSource, roots.canonicalTarget],
  ]) {
    const prefix = source!.replaceAll("\\", "/");
    const windows = /^[A-Za-z]:\//.test(prefix);
    const comparable = windows ? normalized.toLowerCase() : normalized;
    const oldRoot = windows ? prefix.toLowerCase() : prefix;
    if (comparable !== oldRoot && !comparable.startsWith(`${oldRoot}/`)) continue;
    const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
    return (
      target!.replaceAll("\\", separator).replaceAll("/", separator) +
      normalized.slice(prefix.length).replaceAll("/", separator)
    );
  }
  return value;
}
function relocateField(
  record: Record<string, unknown>,
  field: string,
  roots: MigrationRoots,
): void {
  if (typeof record[field] === "string" && isOwnedAssetPath(record[field], roots))
    record[field] = relocateStoragePath(record[field], roots);
}
function relocateLocalSource(value: unknown, roots: MigrationRoots): void {
  if (isRecord(value) && (value.source === "file" || value.source === "directory"))
    relocateField(value, "path", roots);
}

/** 只有这些持久化 owner 声明的文件/字段可重定位，业务 JSON 和任意 plugin.json 不解析。 */
export function isRelocatableMetadataFile(local: string): boolean {
  return (
    local === "cli/config.json" ||
    /^(?:cli\/)?plugins\/(?:installed_plugins|known_marketplaces)\.json$/.test(local) ||
    /^(?:cli\/)?plugins\/marketplaces\/[^/]+\/(?:marketplace|cdn-marketplace|bundled-marketplace)\.json$/.test(
      local,
    )
  );
}
export function relocateDataDirectoryMetadata(
  local: string,
  value: unknown,
  roots: MigrationRoots,
): void {
  if (!isRecord(value) || !isRelocatableMetadataFile(local)) return;
  if (local === "cli/config.json") {
    if (isRecord(value.storage)) {
      for (const field of ["dir", "sessionDbPath"])
        if (typeof value.storage[field] === "string")
          value.storage[field] = relocateStoragePath(value.storage[field], roots);
    }
    relocateCliPathOverrides(value, roots);
    return;
  }
  if (local.endsWith("/installed_plugins.json")) {
    const records = Array.isArray(value.plugins)
      ? value.plugins
      : isRecord(value.plugins)
        ? Object.values(value.plugins).flatMap((item) => (Array.isArray(item) ? item : [item]))
        : [];
    for (const record of records)
      if (isRecord(record)) {
        relocateField(record, "installPath", roots);
        relocateLocalSource(record.source, roots);
      }
    return;
  }
  if (local.endsWith("/known_marketplaces.json")) {
    for (const record of Array.isArray(value.marketplaces) ? value.marketplaces : [])
      if (isRecord(record)) relocateLocalSource(record.source, roots);
    return;
  }
  const manifest =
    local.endsWith("/bundled-marketplace.json") && isRecord(value.manifest)
      ? value.manifest
      : value;
  for (const plugin of Array.isArray(manifest.plugins) ? manifest.plugins : [])
    if (isRecord(plugin)) {
      relocateField(plugin, "cachePath", roots);
      relocateLocalSource(plugin.source, roots);
    }
}
