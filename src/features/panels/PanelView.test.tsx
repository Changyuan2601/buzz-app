// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PanelView } from "./PanelView";
import type { PanelProps, RegisteredPanel } from "./service";

afterEach(cleanup);

test("unreviewed recovery requires Resume; normal openings and audited views mount directly", async () => {
  const user = userEvent.setup();
  const mounted = vi.fn();
  const panel: RegisteredPanel = {
    key: "example/view",
    pluginId: "example",
    id: "view",
    revision: "one",
    title: "Example",
    matches: () => true,
    component: ({ restored }: PanelProps) => {
      useEffect(() => {
        mounted(restored);
      }, [restored]);
      return <input aria-label="Panel draft" />;
    },
  };
  const view = render(
    <StrictMode>
      <PanelView panel={panel} restored target="first" close={() => {}} />
    </StrictMode>,
  );
  expect(mounted).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(
    screen.getByRole("textbox", { name: "Panel draft" }),
  ).toBeInTheDocument();
  expect(mounted).toHaveBeenCalledWith(true);
  const count = mounted.mock.calls.length;
  view.rerender(
    <PanelView
      panel={{ ...panel, revision: "two" }}
      restored
      target="first"
      close={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  expect(mounted).toHaveBeenCalledTimes(count);
  view.rerender(
    <PanelView
      panel={{ ...panel, restore: "view" }}
      restored
      target="second"
      close={() => {}}
    />,
  );
  expect(mounted).toHaveBeenLastCalledWith(true);
  view.rerender(<PanelView panel={panel} target="third" close={() => {}} />);
  expect(mounted).toHaveBeenLastCalledWith(undefined);
});
