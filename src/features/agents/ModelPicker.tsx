// A type's model choice, shared by agent types for the New agent dialog and
// their settings. Each type decides whether its catalog accepts custom IDs.
import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  ClaudeLogoIcon,
  GoogleLogoIcon,
  MetaLogoIcon,
  CodexLogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { ModelFamilyMenu } from "./ModelFamilyMenu";
import { Select } from "../../shared/design-system/ui/Select";

export type ModelChoice = Readonly<{
  /** The model ID saved in the type's config. */
  id: string;
  label: string;
  description?: string | undefined;
  efforts?: readonly { id: string; label: string }[];
  effortScope?: string;
  loadEfforts?: () => Promise<readonly { id: string; label: string }[]>;
}>;

const CUSTOM_MODEL_ACTION: ModelChoice = {
  id: "\0custom-model",
  label: "Custom model",
  description: "Enter a model ID",
};

/** Recognizes the vendor from a model's ID or name. */
export function ModelIcon({ model }: { model: string }) {
  const name = model.toLowerCase();
  const Icon = /claude|anthropic|opus|sonnet|haiku/.test(name)
    ? ClaudeLogoIcon
    : /(?:^|[\s/._-])(?:gpt|codex|o[134](?:[\s/._-]|$))|openai/.test(name)
      ? CodexLogoIcon
      : /gemini/.test(name)
        ? GoogleLogoIcon
        : /llama/.test(name)
          ? MetaLogoIcon
          : RobotIcon;
  return <Icon size={20} aria-hidden="true" />;
}

/** The custom-model form. Create hosts it outside its closing menu; Settings
 * renders it beside the field that opened it. */
export function CustomModelDialog({
  initialValue,
  onSubmit,
  onClose,
  finalFocus = false,
}: {
  initialValue: string;
  onSubmit(model: string): void;
  onClose(): void;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const [model, setModel] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const form = useId();
  return (
    <Dialog
      size="compact"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Custom model"
      headerGap="compact"
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            disabled={!model.trim()}
          >
            Use model
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const value = model.trim();
          if (value) onSubmit(value);
        }}
      >
        <Field label="Model ID" labelVisibility="hidden">
          <Input
            ref={input}
            value={model}
            placeholder="Enter a model ID"
            required
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setModel(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** `value` is a model ID, or "" for the type's default, `defaultLabel`. */
export function ModelPicker({
  label = "Model",
  groupByFamily = false,
  leading,
  onConfigure,
  resetLabel,
  modelLabelPrefixes,
  effort,
  effortLabel,
  onEffortChange,
  models,
  allowCustomModel = false,
  value,
  defaultLabel,
  defaultModel,
  defaultDescription,
  onChange,
  loading = false,
  pending = false,
  disabled = false,
  compact = false,
  appearance = "outlined",
  includeDefault = true,
  description,
}: {
  label?: string;
  resetLabel?: string;
  groupByFamily?: boolean;
  leading?: ReactNode;
  onConfigure?: (() => void) | undefined;
  modelLabelPrefixes?: readonly string[] | undefined;
  effort?: string | undefined;
  effortLabel?: string | undefined;
  onEffortChange?: ((model: string, effort: string) => void) | undefined;
  models: readonly ModelChoice[];
  /** Whether text absent from `models` may be committed as its model ID. */
  allowCustomModel?: boolean;
  compact?: boolean;
  appearance?: "outlined" | "glass-ghost";
  includeDefault?: boolean;
  value: string;
  defaultLabel: string;
  defaultModel?: string | undefined;
  defaultDescription?: string;
  onChange(value: string): void;
  loading?: boolean;
  /** A pending write retains the selected label while blocking new choices. */
  pending?: boolean;
  disabled?: boolean;
  description?: string | undefined;
}) {
  const [customModel, setCustomModel] = useState<string | null>(null);
  const control = useRef<HTMLDivElement>(null);
  const defaultChoice = models.find((model) => model.id === defaultModel);
  const fallback: ModelChoice = {
    id: "",
    label: defaultChoice?.label ?? defaultLabel,
    description: defaultChoice?.description ?? defaultDescription,
  };
  const items: ModelChoice[] = includeDefault
    ? [
        fallback,
        ...models.filter(
          (model) => model.id !== defaultModel || model.id === value,
        ),
      ]
    : [...models];
  if (value && !items.some((model) => model.id === value))
    items.push({
      id: value,
      label: value,
      description: allowCustomModel ? "Custom model" : "Unavailable model",
    });
  const shown = items.map((model) => {
    const prefix = modelLabelPrefixes?.find((prefix) =>
      model.label.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    return {
      ...model,
      label: prefix ? model.label.slice(prefix.length) : model.label,
    };
  });
  const selected =
    shown.find((model) => model.id === (value || defaultModel)) ?? fallback;
  const inherited = value === "";
  const selectedLabel = inherited
    ? `${selected.label} · Default`
    : selected.label;
  const discovering = loading && !pending;
  const choices =
    allowCustomModel && !compact ? [...shown, CUSTOM_MODEL_ACTION] : shown;
  const openCustomDialog = () => {
    const listed = !value || models.some((model) => model.id === value);
    const initialValue = listed ? "" : value;
    setCustomModel(initialValue);
  };
  return (
    <>
      <div ref={control}>
        {groupByFamily ? (
          <ModelFamilyMenu
            leading={leading}
            appearance={appearance}
            resetLabel={resetLabel}
            effort={effort}
            effortLabel={effortLabel}
            onEffortChange={
              onEffortChange
                ? (model, level) =>
                    onEffortChange(
                      inherited && model === defaultModel ? "" : model,
                      level,
                    )
                : undefined
            }
            inherited={!discovering && inherited}
            label={label}
            compact={compact}
            onConfigure={onConfigure}
            models={shown.filter((model) => model.id !== "")}
            selected={
              discovering ? { ...selected, label: "Loading models…" } : selected
            }
            defaultChoice={includeDefault ? fallback : undefined}
            disabled={disabled}
            loading={loading || pending}
            description={description}
            onChange={onChange}
            onCustom={allowCustomModel ? openCustomDialog : undefined}
          />
        ) : (
          <Select
            label={label}
            value={selected.id}
            valueLabel={discovering ? "Loading models…" : selected.label}
            valueSuffix={!discovering && inherited ? " · Default" : undefined}
            valueTitle={discovering ? "Loading models…" : selectedLabel}
            leading={<ModelIcon model={`${selected.id} ${selected.label}`} />}
            variant={compact ? "compact" : "preference"}
            appearance={appearance}
            {...(appearance === "glass-ghost" ? { size: "xs" as const } : {})}
            align={compact ? "end" : "start"}
            groups={[
              {
                label: "",
                options: choices.map((model) => ({
                  value: model.id,
                  label:
                    includeDefault && model.id === ""
                      ? `${model.label} · Default`
                      : model.label,
                  description: model.description,
                  leading: <ModelIcon model={`${model.id} ${model.label}`} />,
                })),
              },
            ]}
            disabled={disabled || loading || pending}
            description={description}
            onValueChange={(model) => {
              if (model === CUSTOM_MODEL_ACTION.id) openCustomDialog();
              else onChange(model);
            }}
          />
        )}
      </div>
      {allowCustomModel && customModel !== null && (
        <CustomModelDialog
          initialValue={customModel}
          onClose={() => setCustomModel(null)}
          onSubmit={(model) => {
            onChange(model);
            setCustomModel(null);
          }}
          finalFocus={() =>
            control.current?.querySelector<HTMLElement>(
              "[role=combobox], [aria-haspopup=menu]",
            ) ?? false
          }
        />
      )}
    </>
  );
}
