// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import type { PresenceStatus } from "../presence/presence";
import { AgentChoice, agentAdmission } from "./AgentChoice";

afterEach(cleanup);

it("reloads the selected agent after the connection clears the library", async () => {
  const pubkey = "a".repeat(64);
  const read = vi.fn(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Selected agent" }],
  }));
  const library = createAgentLibrary(read);
  const session = {
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  } as RelaySession;
  const view = render(
    <StrictMode>
      <AgentChoice session={session} value={pubkey} onChange={vi.fn()} />
    </StrictMode>,
  );
  expect(
    await screen.findByRole("button", { name: "Change agent: Selected agent" }),
  ).toHaveTextContent("Selected agent");
  await act(async () => library.clear());
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByRole("button", { name: "Change agent: Selected agent" }),
  ).toHaveTextContent("Selected agent");
  view.unmount();
  library.dispose();
});

it("searches agents and selects with Enter without submitting the composer", async () => {
  const user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Fizz" }],
  }));
  const onChange = vi.fn(),
    onSubmit = vi.fn();
  render(
    <form onSubmit={onSubmit}>
      <AgentChoice
        session={
          {
            agentChoices: createAgentChoices({
              scope: "test",
              library: library.queries,
              signal: new AbortController().signal,
            }),
          } as RelaySession
        }
        value=""
        onChange={onChange}
      />
    </form>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Choose an agent" }),
  );
  const search = await screen.findByRole("searchbox", {
    name: "Search agents",
  });
  await user.type(search, "no match");
  expect(screen.getByText("No matching agents.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Fizz" })).toBeNull();
  await user.clear(search);
  await user.type(search, "fIzZ");
  expect(screen.getByRole("button", { name: "Fizz" })).toBeVisible();
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith(pubkey);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  library.dispose();
});

it("names known agent presence on the selected trigger and choices", async () => {
  const user = userEvent.setup();
  const pubkey = "a".repeat(64);
  let status: PresenceStatus = "unknown";
  const listeners = new Set<() => void>();
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey, name: "Fizz" }],
  }));
  const session = {
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
    presence: {
      status: () => status,
      limited: () => false,
      subscribe: (_key: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const view = render(
    <AgentChoice session={session} value={pubkey} onChange={vi.fn()} />,
  );
  expect(
    await screen.findByRole("button", { name: "Change agent: Fizz" }),
  ).toBeTruthy();
  act(() => {
    status = "away";
    for (const listener of listeners) listener();
  });
  const trigger = screen.getByRole("button", {
    name: "Change agent: Fizz, away",
  });
  await user.click(trigger);
  expect(
    await screen.findByRole("button", { name: "Fizz, away" }),
  ).toBeTruthy();
  act(() => {
    status = "unknown";
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("button", { name: "Change agent: Fizz" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fizz" })).toBeTruthy();
  view.rerender(
    <AgentChoice
      session={session}
      value={pubkey}
      onChange={vi.fn()}
      allowed={[]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Fizz — adds to channel" }),
  ).toHaveTextContent("Adds to channel");
  act(() => {
    status = "online";
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByRole("button", {
      name: "Fizz, online — adds to channel",
    }),
  ).toHaveTextContent("Adds to channel");
  library.dispose();
});

it("distinguishes session admission from parent-channel admission", () => {
  const member = "a".repeat(64);
  const outside = "b".repeat(64);
  expect(agentAdmission(member, undefined, [member], [])).toBeUndefined();
  expect(agentAdmission(outside, undefined, [member], [outside])).toBe(
    "session",
  );
  expect(agentAdmission(outside, undefined, [member], [])).toBe(
    "session-and-channel",
  );
});

it("does not offer an archived agent, and demands archive evidence on mount", async () => {
  const user = userEvent.setup();
  const archived = "a".repeat(64),
    active = "b".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [
      { pubkey: archived, name: "Retired" },
      { pubkey: active, name: "Fizz" },
    ],
  }));
  const listeners = new Set<() => void>();
  let snapshot: { status: "idle" | "ready"; archived: string[] } = {
    status: "idle",
    archived: [],
  };
  const ensure = vi.fn(async () => {
    if (snapshot.status !== "idle") return;
    snapshot = { status: "ready", archived: [archived] };
    for (const listener of listeners) listener();
  });
  const archives = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: (key: string) =>
      snapshot.status !== "ready"
        ? ("unknown" as const)
        : snapshot.archived.includes(key)
          ? ("archived" as const)
          : ("not-archived" as const),
    ensure,
    refresh: ensure,
  };
  const session = {
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      archives,
      signal: new AbortController().signal,
    }),
  } as RelaySession;
  render(<AgentChoice session={session} value="" onChange={vi.fn()} />);
  await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
  await user.click(
    await screen.findByRole("button", { name: "Choose an agent" }),
  );
  expect(
    await screen.findByRole("button", { name: "Fizz" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retired" }),
  ).not.toBeInTheDocument();
  library.dispose();
});

it("shows an archive read failure and removes the archived agent after Retry", async () => {
  const user = userEvent.setup();
  const archived = "a".repeat(64),
    active = "b".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [
      { pubkey: archived, name: "Retired" },
      { pubkey: active, name: "Fizz" },
    ],
  }));
  const listeners = new Set<() => void>();
  let snapshot: {
    status: "idle" | "ready" | "error";
    archived: string[];
    error?: string;
  } = { status: "idle", archived: [] };
  let fail = true;
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const read = vi.fn(async () => {
    publish(
      fail
        ? { status: "error", archived: [], error: "Archive read failed" }
        : { status: "ready", archived: [archived] },
    );
  });
  const archives = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: (key: string) =>
      snapshot.status !== "ready"
        ? ("unknown" as const)
        : snapshot.archived.includes(key)
          ? ("archived" as const)
          : ("not-archived" as const),
    ensure: vi.fn(async () => {
      if (snapshot.status === "idle") await read();
    }),
    refresh: read,
  };
  const session = {
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      archives,
      signal: new AbortController().signal,
    }),
  } as RelaySession;
  render(<AgentChoice session={session} value="" onChange={vi.fn()} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await user.click(
    await screen.findByRole("button", { name: "Choose an agent" }),
  );
  // Fail open: the choices stay, and the failure and its recovery are visible.
  expect(
    await screen.findByRole("button", { name: "Retired" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Couldn’t check which agents are archived/),
  ).toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Retry agent list" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retired" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Fizz" })).toBeInTheDocument();
  expect(
    screen.queryByText(/Couldn’t check which agents are archived/),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry agent list" }),
  ).not.toBeInTheDocument();
  library.dispose();
});
