// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentsSnapshot } from "../../features/agents/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { DeletedAgentsSettings } from "./DeletedAgentsSettings";

afterEach(cleanup);

const agent = (name: string, lifecycle?: Agent["lifecycle"]) =>
  ({
    pubkey: name,
    name,
    type: "goose",
    owner: "o",
    relay: "wss://r",
    place: "here",
    attention: {},
    skipped: {},
    timers: {},
    attentionEnabled: false,
    config: {},
    ...(lifecycle ? { lifecycle } : {}),
  }) as Agent;

function fake(running: Agent[], recover = vi.fn(async () => {})) {
  const state = {
    status: "ready",
    classifier: "unavailable",
    classifierKey: "missing",
    agents: [],
    running,
    teams: [],
  } as AgentsSnapshot;
  return { snapshot: () => state, subscribe: () => () => {}, recover };
}

it("lists only deleted agents and recovers an archived one", async () => {
  const agents = fake([
    agent("Live"),
    agent("Gone", "archived"),
    agent("Leaving", "archiving"),
  ]);
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  expect(screen.queryByText("Live")).toBeNull();
  expect(screen.getByText(/Deleting…/)).toBeInTheDocument();
  const buttons = screen.getAllByRole("button", { name: "Recover" });
  expect(buttons).toHaveLength(1);
  await userEvent.click(buttons[0] as HTMLElement);
  expect(agents.recover).toHaveBeenCalledWith("Gone");
});

it("shows why a recovery did not finish", async () => {
  const agents = fake(
    [agent("Gone", "archived")],
    vi.fn(async () => {
      throw new Error("Gone isn't recovered yet");
    }),
  );
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  await userEvent.click(screen.getByRole("button", { name: "Recover" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Gone isn't recovered yet",
  );
});

/** Agents whose Recover moves the row to `recovering`, then settles it. */
function recovering(succeeds: boolean) {
  let state = {
    status: "ready",
    classifier: "unavailable",
    classifierKey: "missing",
    agents: [],
    running: [agent("Gone", "archived")],
    teams: [],
  } as AgentsSnapshot;
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const listener of listeners) listener();
  };
  let finish!: () => void;
  const recover = vi.fn(async () => {
    set([agent("Gone", "recovering")]);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (succeeds) return set([]);
    set([agent("Gone", "archived")]);
    throw new Error("Gone isn't recovered yet");
  });
  return {
    agents: {
      snapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      recover,
    },
    finish: () => finish(),
  };
}

it("keeps keyboard focus on Recover while it runs and after it is refused", async () => {
  const { agents, finish } = recovering(false);
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  screen.getByRole("button", { name: "Recover" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: /Recover/ }),
  );
  finish();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Recover" }),
  );
});

it("moves focus to the list's heading once a recovered agent leaves it", async () => {
  const { agents, finish } = recovering(true);
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  screen.getByRole("button", { name: "Recover" }).focus();
  await userEvent.keyboard("{Enter}");
  finish();
  expect(await screen.findByText("No deleted agents.")).toBeInTheDocument();
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Deleted agents" }),
  );
});

it("moves focus to the heading and clears the error when a held recovery finishes after reconnect", async () => {
  let state = fake([agent("Gone", "archived")]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const listener of listeners) listener();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    recover: vi.fn(async () => {
      set([agent("Gone", "recovering")]);
      throw new Error(
        "Gone isn't recovered yet; it keeps trying while connected.",
      );
    }),
  };
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  screen.getByRole("button", { name: "Recover" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Recover" })).toHaveFocus();
  act(() => set([]));
  expect(screen.getByRole("heading", { name: "Deleted agents" })).toHaveFocus();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("leaves focus where the user moved it when a held recovery finishes later", async () => {
  let state = fake([agent("Gone", "archived")]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const listener of listeners) listener();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    recover: vi.fn(async () => {
      set([agent("Gone", "recovering")]);
      throw new Error(
        "Gone isn't recovered yet; it keeps trying while connected.",
      );
    }),
  };
  render(
    <>
      <DeletedAgentsSettings agents={agents} active={() => true} />
      <button type="button">Elsewhere</button>
    </>,
    { wrapper: ToastProvider },
  );
  screen.getByRole("button", { name: "Recover" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  act(() => set([]));
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});

it("restores focus when the first of two pending Recover rows disappears", async () => {
  let state = fake([
    agent("First", "archived"),
    agent("Second", "archived"),
  ]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const fn of listeners) fn();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    recover: vi.fn(async (key: string) => {
      set(
        state.running.map((a) =>
          a.pubkey === key ? { ...a, lifecycle: "recovering" } : a,
        ),
      );
      throw new Error(`${key} keeps trying while connected`);
    }),
  };
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  screen.getAllByRole("button", { name: "Recover" })[0]?.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  screen.getAllByRole("button", { name: "Recover" })[1]?.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Second");
  // Both are pending in the service, but the owner returns focus to First.
  screen.getAllByRole("button", { name: "Recover" })[0]?.focus();
  act(() => set([agent("Second", "recovering")]));
  expect(screen.getByRole("heading", { name: "Deleted agents" })).toHaveFocus();
  // Completion of First must not erase Second's still-pending message.
  expect(screen.getByRole("alert")).toHaveTextContent("Second");
});

it("does not focus the heading when the recovered row did not own body focus", async () => {
  let state = fake([agent("First", "archived")]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const fn of listeners) fn();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    recover: vi.fn(async () => {
      set([agent("First", "recovering")]);
      throw new Error("First keeps trying");
    }),
  };
  render(
    <>
      <DeletedAgentsSettings agents={agents} active={() => true} />
      <button type="button">Elsewhere</button>
    </>,
    { wrapper: ToastProvider },
  );
  screen.getByRole("button", { name: "Recover" }).focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  screen.getByRole("button", { name: "Elsewhere" }).blur();
  expect(document.body).toHaveFocus();
  act(() => set([]));
  expect(document.body).toHaveFocus();
});

it("announces a held recovery that finishes while other rows remain", async () => {
  let state = fake([
    agent("First", "archived"),
    agent("Second", "archived"),
  ]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const fn of listeners) fn();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    recover: vi.fn(async () => {
      set([agent("First", "recovering"), agent("Second", "archived")]);
      throw new Error("First keeps trying while connected");
    }),
  };
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  const recover = screen.getAllByRole("button", { name: "Recover" })[1];
  screen.getAllByRole("button", { name: "Recover" })[0]?.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  recover?.focus();
  act(() => set([agent("First"), agent("Second", "archived")]));
  // A toast announces it, and focus stays where the owner is.
  expect(await screen.findByText("Recovered First.")).toBeInTheDocument();
  expect(recover).toHaveFocus();
});

it("does not announce recovery when the pending agent merely leaves the running community", async () => {
  const first = { ...agent("First", "archived"), relay: "https://first.test" };
  const second = {
    ...agent("Second", "archived"),
    relay: "https://second.test",
  };
  let state = fake([first, second]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const fn of listeners) fn();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    recover: vi.fn(async () => {
      set([{ ...first, lifecycle: "recovering" }, second]);
      throw new Error("First keeps trying");
    }),
  };
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  screen.getAllByRole("button", { name: "Recover" })[0]?.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  screen.getAllByRole("button", { name: "Recover" })[1]?.focus();
  // AgentsService.running excludes a community in disconnected state even though its lifecycle journal still says recovering.
  act(() => set([second]));
  expect(screen.queryByText("Recovered First.")).toBeNull();
  // The request is still pending: its real completion is announced.
  act(() => set([agent("First"), second]));
  expect(await screen.findByText("Recovered First.")).toBeInTheDocument();
});

it("preserves another row's error and focus when one held recovery finishes", async () => {
  let state = fake([
    agent("First", "archived"),
    agent("Second", "archived"),
  ]).snapshot();
  const listeners = new Set<() => void>();
  const set = (running: Agent[]) => {
    state = { ...state, running };
    for (const fn of listeners) fn();
  };
  const agents = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    recover: vi.fn(async (key: string) => {
      if (key === "First")
        set([agent("First", "recovering"), agent("Second", "archived")]);
      throw new Error(`${key} keeps trying`);
    }),
  };
  render(<DeletedAgentsSettings agents={agents} active={() => true} />, {
    wrapper: ToastProvider,
  });
  screen.getAllByRole("button", { name: "Recover" })[0]?.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("alert");
  screen.getAllByRole("button", { name: "Recover" })[1]?.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("alert")).toHaveTextContent("Second keeps trying");
  act(() => set([agent("First"), agent("Second", "archived")]));
  expect(screen.getByRole("alert")).toHaveTextContent("Second keeps trying");
  expect(screen.getAllByRole("button", { name: "Recover" })[0]).toHaveFocus();
  expect(await screen.findByText("Recovered First.")).toBeInTheDocument();
});
