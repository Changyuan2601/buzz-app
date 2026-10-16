import type { ReactNode } from "react";

/** A quiet boundary for related settings; children own controls and state. */
export function SettingsGroup({
  children,
  layout = "rows",
}: {
  children: ReactNode;
  /** `cards` gives each child its own bordered card instead of dividers. */
  layout?: "rows" | "form" | "cards";
}) {
  return (
    <div data-buzz-ui="" className="buzz-settings-group" data-layout={layout}>
      {children}
    </div>
  );
}
