// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { InstructionProposalProvider } from "./InstructionProposal";
import type { Agent, Agents } from "./service";
import { AgentInstructions } from "./AgentInstructions";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  initial = "",
  disabled = false,
  onChange,
}: {
  initial?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AgentInstructions
      value={value}
      disabled={disabled}
      description="Added to every session."
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

it("is a plain labelled field outside the card", async () => {
  const user = userEvent.setup();
  render(<Harness initial="Be kind." />);
  const field = screen.getByLabelText("Instructions");
  expect(field).toHaveValue("Be kind.");
  expect(field).toHaveAccessibleDescription("Added to every session.");
  expect(
    screen.queryByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).not.toBeInTheDocument();
  await user.type(field, " Really.");
  expect(field).toHaveValue("Be kind. Really.");
});

it("disables the plain field", () => {
  render(<Harness disabled />);
  expect(screen.getByLabelText("Instructions")).toBeDisabled();
});

it("asks before replacing a changed instructions draft, and never treats applying as saving", async () => {
  const user = userEvent.setup();
  const agent = {
    pubkey: "agent",
    type: "test/type",
    config: { instructions: "original" },
  } as Agent;
  const dismissInstructionProposal = vi.fn();
  const agents = {
    instructionProposal: () => proposal,
    subscribeInstructionProposals: () => () => {},
    dismissInstructionProposal,
  } as unknown as Agents;
  const proposal = {
    id: "proposal",
    type: agent.type,
    basedOn: "original",
    text: "Suggested replacement",
  };
  const onChange = vi.fn();
  render(
    <InstructionProposalProvider agent={agent} agents={agents}>
      <Harness initial="manual draft" onChange={onChange} />
    </InstructionProposalProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Apply to draft" }));
  expect(
    screen.getByRole("alertdialog", {
      name: "Replace the instructions draft?",
    }),
  ).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue("manual draft");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Apply to draft" })).toHaveFocus();
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Apply to draft" }));
  await user.click(screen.getByRole("button", { name: "Replace draft" }));
  expect(screen.getByLabelText("Instructions")).toHaveValue(
    "Suggested replacement",
  );
  expect(dismissInstructionProposal).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
  expect(dismissInstructionProposal).toHaveBeenCalledWith("agent", "proposal");
});
