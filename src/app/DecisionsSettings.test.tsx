// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentsSnapshot } from "../features/agents/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(cleanup);

/** Agents as far as the card uses it, with a key store that can fail. */
function fake(
  status: AgentsSnapshot["status"] = "ready",
  classifierKey: AgentsSnapshot["classifierKey"] = "missing",
) {
  let state: AgentsSnapshot = {
    status,
    classifier: "unavailable",
    classifierKey,
    agents: [],
    running: [],
    interrupted: [],
    teams: [],
  };
  const listeners = new Set<() => void>();
  const set = (classifierKey: AgentsSnapshot["classifierKey"]) => {
    state = { ...state, classifierKey };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setClassifierKey: vi.fn(async (_key: string) => set("saved")),
    clearClassifierKey: vi.fn(async () => set("missing")),
  };
}

it("asks for the TypeSafe key, with no provider choice", () => {
  render(<DecisionsSettings agents={fake()} active={() => true} />);
  expect(screen.getByRole("heading", { name: "Decisions API" })).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Decisions API Provider" }),
  ).toBeNull();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByLabelText("TypeSafe API key")).toBeInTheDocument();
});

it("asks for the desktop app in the browser", () => {
  render(
    <DecisionsSettings agents={fake("unavailable")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByLabelText("TypeSafe API key")).not.toBeInTheDocument();
});

it("saves a key without showing it again, and removes it", async () => {
  const user = userEvent.setup();
  const agents = fake();
  render(<DecisionsSettings agents={agents} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Add your TypeSafe API key",
  );
  const input = screen.getByLabelText("TypeSafe API key");
  expect(input).toHaveAttribute("type", "password");
  expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  await user.type(input, "  tk-secret  ");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(agents.setClassifierKey).toHaveBeenCalledWith("tk-secret");
  expect(input).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Your TypeSafe key is saved",
  );
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(agents.clearClassifierKey).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Add your TypeSafe API key",
  );
});

it("keeps the typed key and shows why a save failed", async () => {
  const user = userEvent.setup();
  const agents = fake();
  agents.setClassifierKey.mockRejectedValueOnce(
    new Error("That does not look like a TypeSafe API key"),
  );
  render(<DecisionsSettings agents={agents} active={() => true} />);
  await user.type(screen.getByLabelText("TypeSafe API key"), "bad key");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not look like",
  );
  expect(screen.getByLabelText("TypeSafe API key")).toHaveValue("bad key");
});

it("does not call a key missing until its status is read, or when it cannot be", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <DecisionsSettings
      agents={fake("ready", "checking")}
      active={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Checking");
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  const unreadable = fake("ready", "unreadable");
  rerender(<DecisionsSettings agents={unreadable} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("could not read");
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove key" }));
  expect(unreadable.clearClassifierKey).toHaveBeenCalledOnce();
  rerender(
    <DecisionsSettings agents={fake("ready", "refused")} active={() => true} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "TypeSafe did not accept your key",
  );
  expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
});

it.each([
  [true, /this Mac's Keychain, where only Buzz can read it/],
  [false, /Other programs you run, agent shells included, can read it/],
])(
  "says where the key is kept and who can read it (Keychain: %s)",
  (apple, text) => {
    render(
      <DecisionsSettings agents={fake()} active={() => true} apple={apple} />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  },
);

it("says once, in the header, that the provider receives message text", () => {
  render(<DecisionsSettings agents={fake()} active={() => true} />);
  const disclosure = screen.getByText(/provider receives the message text/);
  expect(disclosure).toHaveTextContent("private channels");
  expect(disclosure).not.toHaveTextContent("TypeSafe");
  expect(
    disclosure.compareDocumentPosition(
      screen.getByLabelText("TypeSafe API key"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
