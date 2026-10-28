import { Component, useState, type ReactNode } from "react";
import type { PanelProps, RegisteredPanel } from "./service";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Button } from "../../shared/design-system/ui/Button";
import { BrowserIcon } from "../../shared/design-system/icons";

// Pages own placement and closing; this boundary contains a plugin's render errors.
export function PanelView({
  panel,
  ...props
}: PanelProps & { panel: RegisteredPanel }) {
  return (
    <PanelBoundary key={`${panel.key}:${panel.revision}:${props.target}`}>
      <RecoveredPanel panel={panel} {...props} />
    </PanelBoundary>
  );
}
function RecoveredPanel({
  panel,
  ...props
}: PanelProps & { panel: RegisteredPanel }) {
  const [resumed, setResumed] = useState(false);
  const Content = panel.component;
  if (props.restored && panel.restore !== "view" && !resumed)
    return (
      <EmptyState
        icon={<BrowserIcon />}
        title={`Resume ${panel.title}`}
        description="This tab was restored. Resume it to reopen its content."
        action={<Button onClick={() => setResumed(true)}>Resume</Button>}
      />
    );
  return <Content {...props} />;
}

class PanelBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }
  render() {
    return this.state.error ? (
      <div role="alert" className="notice">
        <h3>This panel couldn’t open</h3>
        <p>{this.state.error}</p>
      </div>
    ) : (
      this.props.children
    );
  }
}
