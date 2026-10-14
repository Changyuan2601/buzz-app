import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";

const EXAMPLE = "Help me plan my week and prioritize tasks.";
const PLACEHOLDER = "Describe what I should do…";

export function AgentInstructions({
  value,
  disabled,
  onChange,
  description,
  creation = false,
}: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  description?: string | undefined;
  creation?: boolean;
}) {
  return (
    <Field
      label={creation ? "Describe what I should do" : "Instructions"}
      description={description}
    >
      <Textarea
        surface={creation ? "panel" : "inset"}
        rows={8}
        value={value}
        disabled={disabled}
        placeholder={creation ? EXAMPLE : PLACEHOLDER}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
