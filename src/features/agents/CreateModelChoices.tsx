import { Button } from "../../shared/design-system/ui/Button";
import { ModelPicker, type ModelChoice } from "./ModelPicker";

/** Compact model field; catalogs and config changes stay with the type. */
export function CreateModelChoices({
  modelAppearance,
  models,
  value,
  defaultLabel,
  includeDefault = true,
  onChange,
  loading = false,
  disabled,
  error,
  retry,
}: {
  modelAppearance?: "subtle";
  models: readonly ModelChoice[];
  value: string;
  defaultLabel: string;
  includeDefault?: boolean;
  onChange(value: string): void;
  loading?: boolean;
  disabled: boolean;
  error?: string;
  retry?: () => void;
}) {
  return (
    <>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
        <ModelPicker
          includeDefault={includeDefault}
          appearance={modelAppearance ?? "outlined"}
          {...{ models, value, defaultLabel, onChange, loading, disabled }}
          compact
        />
        {error && retry && (
          <Button size="sm" disabled={loading || disabled} onClick={retry}>
            Try again
          </Button>
        )}
      </div>
      {error && (
        <span role="alert" className="text-body-sm text-danger">
          {error}
        </span>
      )}
    </>
  );
}
