import type { GlobalDatabaseStartupProps } from "./contract.js";
export function databaseStartupViewExample(
  state: GlobalDatabaseStartupProps["state"],
  onRetry: () => void,
  onExit: () => void,
): GlobalDatabaseStartupProps {
  return { state, onRetry, onExit, onCopy: (details) => navigator.clipboard.writeText(details) };
}
