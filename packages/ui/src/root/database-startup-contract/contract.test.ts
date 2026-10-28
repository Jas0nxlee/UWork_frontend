import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { GlobalDatabaseStartupLoading } from "./index.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/root/RootStartupLoading.js", () => ({
  RootStartupLoading: ({ label, children }: { label: string; children: ReactNode }) =>
    createElement("div", null, label, children),
}));
it("shows cold data movement before a schema migration counter exists", () => {
  const html = renderToStaticMarkup(
    createElement(GlobalDatabaseStartupLoading, {
      state: {
        schemaVersion: 1,
        operation: "data-directory-migration",
        startupId: "cold",
        attemptId: "attempt",
        sequence: 1,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        phase: "preparing_host_storage",
        databasePhase: "migrating",
        disk: [],
      },
      onRetry: () => {},
      onExit: () => {},
      onCopy: async () => {},
    }),
  );
  expect(html).toContain("startup.global.dataDirectoryMigration");
  expect(html).toContain('data-testid="database-startup-status"');
});
it("offers cancel only for a verified precommit cold error", () => {
  const base = {
    schemaVersion: 1 as const,
    startupId: "cold",
    attemptId: "attempt",
    sequence: 1,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    phase: "failed" as const,
    failedPhase: "preparing_host_storage" as const,
    errorCode: "permission_denied" as const,
    disk: [],
  };
  const props = { onRetry: () => {}, onExit: () => {}, onCopy: async () => {}, onCancel: () => {} };
  const cold = renderToStaticMarkup(
    createElement(GlobalDatabaseStartupLoading, {
      ...props,
      state: {
        ...base,
        operation: "data-directory-migration",
        canCancelDataDirectoryMigration: true,
      },
    }),
  );
  expect(cold).toContain("data-directory-startup-cancel");
  const normal = renderToStaticMarkup(
    createElement(GlobalDatabaseStartupLoading, { ...props, state: base }),
  );
  expect(normal).not.toContain("data-directory-startup-cancel");
  const committed = renderToStaticMarkup(
    createElement(GlobalDatabaseStartupLoading, {
      ...props,
      state: {
        ...base,
        operation: "data-directory-migration",
        canCancelDataDirectoryMigration: false,
      },
    }),
  );
  expect(committed).not.toContain("data-directory-startup-cancel");
});
