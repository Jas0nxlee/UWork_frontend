import { Loader2Icon, CircleAlertIcon, CheckCircle2Icon } from "lucide-react";
import type { ReactNode } from "react";
import type { ModelCapabilitySource } from "@zcode/provider";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ModelConfigHelp } from "@/settings/model-provider-section/ModelConfigHelp.js";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";

export function ModelCapabilitySourceNotice({
  source,
  catalogSource,
}: {
  source?: ModelCapabilitySource;
  catalogSource?: ProviderSettingsFormModel["catalogSource"];
}) {
  const { intl, locale } = useZCodeIntl();
  if (!source) return null;
  const fetchedAt = source === "catalog" ? catalogSource?.fetchedAt : undefined;
  const fetchedDate = fetchedAt === undefined ? null : new Date(fetchedAt);
  // 仅有模型 ID 不等于已确认规格；保留兼容默认供编辑，但必须标明其不确定性。
  return (
    <div
      data-testid="model-provider-capability-source"
      data-model-capability-source={source}
      data-capability-source={source}
      role="status"
      className="rounded-lg bg-surface px-3 py-2 text-ui-sm text-foreground-subtle"
    >
      <p>{intl.formatMessage({ id: `settings.modelProvider.capabilitySource.${source}` })}</p>
      {fetchedDate && Number.isFinite(fetchedDate.getTime()) ? (
        <p className="mt-1">
          {intl.formatMessage(
            { id: "settings.modelProvider.catalogFetchedAt" },
            { time: fetchedDate.toLocaleString(locale) },
          )}
        </p>
      ) : null}
      {source === "catalog" && catalogSource?.stale ? (
        <p className="mt-1">{intl.formatMessage({ id: "settings.modelProvider.catalogStale" })}</p>
      ) : null}
      {source === "unknown" ? (
        <p className="mt-1">
          {intl.formatMessage({ id: "settings.modelProvider.capabilityUnconfirmed" })}
        </p>
      ) : null}
    </div>
  );
}

export function ModelConfigRestoreButton({
  disabled,
  onRestore,
}: {
  disabled: boolean;
  onRestore?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="shrink-0 px-0 text-ui-sm text-foreground-subtle underline underline-offset-4 hover:bg-transparent"
      disabled={disabled}
      onClick={onRestore}
    >
      {intl.formatMessage({ id: "settings.modelProvider.resetForm" })}
    </Button>
  );
}

export function ModelConfigDraftFeedback({
  error,
  matched,
}: {
  error?: string | null;
  matched?: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (!error && !matched) return null;
  const Icon = error ? CircleAlertIcon : CheckCircle2Icon;
  return (
    <div
      role={error ? "alert" : "status"}
      className={
        error
          ? "flex min-h-10 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
          : "flex min-h-10 items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-success"
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="text-ui-sm font-medium">
        {error ?? intl.formatMessage({ id: "settings.modelProvider.modelDefaultsLoaded" })}
      </span>
    </div>
  );
}

export function ModelSmartConfigSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: "settings.modelProvider.followRecommendedConfig" });
  return (
    <div
      data-model-recommended-config="true"
      className="flex shrink-0 items-center justify-start gap-2 pt-2 text-ui-base text-foreground"
    >
      <span className="inline-flex items-center whitespace-nowrap">
        {label}
        <ModelConfigHelp field="followRecommendedConfig" />
      </span>
      <Switch disabled={disabled} aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function ProviderModelMetadataDialogActions({
  saveLabel,
  cancelLabel,
  saving,
  onSave,
  onCancel,
  leadingAction,
}: {
  saveLabel: string;
  cancelLabel: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  leadingAction?: ReactNode;
}) {
  return (
    <div data-model-settings-footer="true" className="flex items-center justify-between gap-2 pt-1">
      {leadingAction}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="lg" disabled={saving} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="button" variant="default" size="lg" disabled={saving} onClick={onSave}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
