// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConflictError } from "./instructions";
import { InstructionsPanel } from "./InstructionsPanel";
import type { Agent, AgentInstructionsView, Agents } from "./service";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agent = { pubkey: "a".repeat(64) } as Agent;

function fake(view: AgentInstructionsView) {
  const listeners = new Set<() => void>();
  let current = view;
  const saveInstructions = vi.fn(
    async (_pubkey: string, _text: string, _base?: string) => {},
  );
  const discardInstructionsDraft = vi.fn();
  const agents = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    instructions: () => current,
    saveInstructions,
    discardInstructionsDraft,
  } as unknown as Agents;
  return {
    agents,
    saveInstructions,
    discardInstructionsDraft,
    set(next: AgentInstructionsView) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

it("saves the edited text over the head the editor started from", async () => {
  const { agents, saveInstructions } = fake({
    resolved: { text: "Be brief.", versionId: "v1" } as never,
    head: "v1",
  });
  render(<InstructionsPanel agents={agents} agent={agent} />);
  const field = screen.getByRole("textbox");
  expect(field).toHaveValue("Be brief.");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toHaveAttribute("aria-disabled", "true");
  await userEvent.type(field, " Always.");
  await userEvent.click(save);
  expect(saveInstructions).toHaveBeenCalledWith(
    agent.pubkey,
    "Be brief. Always.",
    "v1",
  );
});

it("shows couldn't-confirm with the refusal reason, and a conflict error", async () => {
  const { agents, saveInstructions, set } = fake({
    resolved: { text: "x", versionId: "v1" } as never,
    head: "v1",
  });
  saveInstructions.mockRejectedValueOnce(
    new Error("Changed on another device"),
  );
  render(<InstructionsPanel agents={agents} agent={agent} />);
  await userEvent.type(screen.getByRole("textbox"), "y");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Changed on another device",
  );
  set({
    resolved: { text: "x", versionId: "v1" } as never,
    head: "v1",
    save: { state: "uncertain", reason: "restricted" } as never,
  });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Couldn't confirm this change saved. restricted",
  );
});

it("keeps a refused save's text and offers Save again", async () => {
  const { agents, saveInstructions } = fake({
    resolved: { text: "old", versionId: "v1" } as never,
    head: "v1",
    submitted: "new",
    save: { state: "rejected", reason: "blocked: no" },
  });
  render(<InstructionsPanel agents={agents} agent={agent} />);
  expect(screen.getByRole("textbox")).toHaveValue("new");
  await userEvent.click(screen.getByRole("button", { name: "Save again" }));
  expect(saveInstructions).toHaveBeenCalledWith(agent.pubkey, "new", "v1");
});

it("reapplies the edit over the newer head after a conflict, or discards it", async () => {
  const { agents, saveInstructions } = fake({
    resolved: { text: "x", versionId: "v1" } as never,
    head: "v1",
  });
  saveInstructions.mockRejectedValueOnce(new ConflictError("v2"));
  render(<InstructionsPanel agents={agents} agent={agent} />);
  await userEvent.type(screen.getByRole("textbox"), "y");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await userEvent.click(await screen.findByRole("button", { name: "Reapply" }));
  expect(saveInstructions).toHaveBeenLastCalledWith(agent.pubkey, "xy", "v2");
  saveInstructions.mockRejectedValueOnce(new ConflictError("v3"));
  await userEvent.type(screen.getByRole("textbox"), "z");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
  expect(screen.getByRole("textbox")).toHaveValue("x");
});

it("offers the pre-history local draft to edit or discard", async () => {
  const { agents, discardInstructionsDraft } = fake({
    resolved: { text: "remote", versionId: "v1" } as never,
    head: "v1",
    draft: "local edit",
  });
  render(<InstructionsPanel agents={agents} agent={agent} />);
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(discardInstructionsDraft).toHaveBeenCalledWith(agent.pubkey);
  await userEvent.click(screen.getByRole("button", { name: "Edit it" }));
  expect(screen.getByRole("textbox")).toHaveValue("local edit");
});
