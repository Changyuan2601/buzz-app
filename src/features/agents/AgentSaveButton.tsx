import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../shared/design-system/ui/Button";

/** The agent sidebar supplies a footer; other hosts retain their inline action. */
export const AgentSaveFooter = createContext<HTMLElement | null>(null);

export function AgentSaveButton({
  form,
  saving,
  disabled,
}: {
  form: string;
  saving: boolean;
  disabled: boolean;
}) {
  const footer = useContext(AgentSaveFooter);
  if (disabled && !saving) return null;
  const button = (
    <Button
      type="submit"
      form={form}
      variant="prominent"
      loading={saving}
      disabled={disabled}
      focusableWhenDisabled
      style={footer ? { width: "100%" } : undefined}
    >
      {saving ? "Saving…" : "Save"}
    </Button>
  );
  return footer ? createPortal(button, footer) : <div>{button}</div>;
}
