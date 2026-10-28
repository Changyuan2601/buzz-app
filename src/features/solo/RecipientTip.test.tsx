// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { RecipientTip, type RecipientTipKind } from "./RecipientTip";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function Tip({ kind }: { kind: RecipientTipKind | undefined }) {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={anchor} />
      <RecipientTip kind={kind} agent="Scout" anchor={anchor} />
    </>
  );
}

it("shows each tip once, until it is dismissed", async () => {
  const view = render(<Tip kind="main-agent" />);
  expect(
    await screen.findByText("Messages go to your main agent"),
  ).toBeVisible();
  expect(screen.getByText(/Scout is added to each new chat/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Got it" }));
  expect(screen.queryByText("Messages go to your main agent")).toBeNull();
  view.unmount();

  // The other tip has its own flag.
  const next = render(<Tip kind="no-agents" />);
  expect(await screen.findByText("Make an agent to start")).toBeVisible();
  next.unmount();

  render(<Tip kind="main-agent" />);
  expect(screen.queryByText("Messages go to your main agent")).toBeNull();
});

it("shows nothing without a kind", () => {
  render(<Tip kind={undefined} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
