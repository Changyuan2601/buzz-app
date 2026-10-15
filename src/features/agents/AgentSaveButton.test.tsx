// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSaveButton, AgentSaveFooter } from "./AgentSaveButton";

afterEach(cleanup);
it("submits its owning form from the sidebar footer and removes the action on unmount", () => {
  const footer = document.createElement("div");
  document.body.append(footer);
  const submit = vi.fn((event) => event.preventDefault());
  try {
    const view = render(
      <AgentSaveFooter value={footer}>
        <form id="agent-settings-test" onSubmit={submit}>
          <AgentSaveButton
            form="agent-settings-test"
            saving={false}
            disabled={false}
          />
        </form>
      </AgentSaveFooter>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(footer).toContainElement(button);
    expect(button.closest("form")).toBeNull();
    expect(button).toHaveStyle({ width: "100%" });
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledOnce();
    view.unmount();
    expect(footer).toBeEmptyDOMElement();
  } finally {
    footer.remove();
  }
});

it("hides the footer action until changes exist and keeps it visible while saving", () => {
  const footer = document.createElement("div");
  document.body.append(footer);
  const action = (disabled: boolean, saving = false) => (
    <AgentSaveFooter value={footer}>
      <AgentSaveButton form="settings" disabled={disabled} saving={saving} />
    </AgentSaveFooter>
  );
  try {
    const view = render(action(true));
    expect(footer).toBeEmptyDOMElement();
    view.rerender(action(false));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    view.rerender(action(true, true));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
    view.rerender(action(true));
    expect(footer).toBeEmptyDOMElement();
  } finally {
    footer.remove();
  }
});
