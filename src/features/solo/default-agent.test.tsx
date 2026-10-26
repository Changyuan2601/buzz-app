// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import {
  chooseDefaultAgent,
  forgetDefaultAgent,
  setDefaultAgent,
  useDefaultAgent,
} from "./default-agent";

const noChannelList = { status: "ready", channels: [] };
const noChannels = {
  ensureList: () => {},
  subscribeList: () => () => {},
  list: () => noChannelList,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("choosing a default updates new-chat routing only in its account/community scope", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    channels: noChannels,
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  expect(screen.getByLabelText("one").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "b".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("Second");
  expect(screen.getByLabelText("two").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "d".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("First");
});

it("waits for complete fallback and settled archive evidence, but honors an available explicit choice", () => {
  const relay = { pubkey: "a".repeat(64), name: "Relay", managed: false };
  const local = { pubkey: "b".repeat(64), name: "Local", managed: true };
  let choices = {
    status: "ready",
    complete: false,
    pending: true,
    selectable: [relay],
    archives: { status: "loading", archived: [] },
  };
  const listeners = new Set<() => void>();
  const session = {
    channels: noChannels,
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="choice">
        {useDefaultAgent(session, "loading")?.name}
      </output>
    );
  }
  render(<Selection />);
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    setDefaultAgent("loading", relay.pubkey);
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Relay");
  act(() => {
    setDefaultAgent("loading", "d".repeat(64));
    choices = {
      ...choices,
      complete: true,
      pending: false,
      selectable: [relay, local],
    };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    choices = { ...choices, archives: { status: "ready", archived: [] } };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Local");
});

it("a requested agent replaces the default, and nothing stands in for it", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    channels: noChannels,
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ requested }: { requested: string }) {
    return (
      <output aria-label={requested.slice(0, 1)}>
        {useDefaultAgent(session, "requested", requested)?.name ?? "none"}
      </output>
    );
  }
  render(
    <>
      <Selection requested={"b".repeat(64)} />
      <Selection requested={"d".repeat(64)} />
    </>,
  );
  expect(screen.getByLabelText("b").textContent).toBe("Second");
  expect(screen.getByLabelText("d").textContent).toBe("none");
});

it("keeps the main agent stable: saves the first pick and replaces only a deleted choice", () => {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  let choices = {
    status: "ready",
    complete: true,
    selectable: [first, second],
    archives: { status: "ready", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof choices>) => {
    choices = { ...choices, ...next };
    for (const notify of listeners) notify();
  };
  const session = {
    channels: noChannels,
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "stable")?.name}
      </output>
    );
  }
  render(<Selection />);
  // The automatic pick is saved, so a different load order doesn't move it.
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [second, first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  // A chosen agent missing for a while is stood in for, then comes back.
  act(() => {
    setDefaultAgent("stable", second.pubkey);
  });
  act(() => update({ selectable: [first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [first, second] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("Second");
  // Deleting it hands the role on for good.
  act(() =>
    update({
      selectable: [first],
      archives: { status: "ready", archived: [second.pubkey] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() =>
    update({
      selectable: [second, first],
      archives: { status: "ready", archived: [] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
});

it("a deleted main agent hands the role on for good, even without archive evidence", () => {
  const [a, b, c] = ["a", "b", "c"].map((letter) => ({
    pubkey: letter.repeat(64),
    name: letter.toUpperCase(),
    managed: true,
  }));
  let choices = {
    status: "ready",
    complete: true,
    selectable: [a, b, c],
    archives: { status: "unavailable", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (selectable: typeof choices.selectable) => {
    choices = { ...choices, selectable };
    for (const notify of listeners) notify();
  };
  const session = {
    channels: noChannels,
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  act(() => {
    setDefaultAgent("one", b?.pubkey ?? "");
    setDefaultAgent("two", c?.pubkey ?? "");
  });
  act(() => {
    update([a, c].filter((agent) => agent !== undefined));
    forgetDefaultAgent(b?.pubkey ?? "");
  });
  expect(screen.getByLabelText("one")).toHaveTextContent("A");
  // Another scope's choice is untouched.
  expect(screen.getByLabelText("two")).toHaveTextContent("C");
  act(() => update([c, a].filter((agent) => agent !== undefined)));
  expect(screen.getByLabelText("one")).toHaveTextContent("A");
});

it("after a finished delete, rereads cached inventory before choosing a replacement", async () => {
  const a = { pubkey: "a".repeat(64), name: "A" };
  const b = { pubkey: "b".repeat(64), name: "B" };
  let rows = [b, a];
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: rows,
  }));
  const agentChoices = createAgentChoices({
    scope: `https://relay.example.test:${"f".repeat(64)}`,
    library: library.queries,
    signal: new AbortController().signal,
  });
  await library.queries.refresh();
  const session = {
    agentChoices,
    channels: noChannels,
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "reread")?.name}
      </output>
    );
  }
  render(<Selection />);
  act(() => {
    setDefaultAgent("reread", b.pubkey);
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("B");
  // B's record is deleted; the cached library still lists it until reread.
  rows = [a];
  await act(async () => {
    await agentChoices.refresh();
    forgetDefaultAgent(b.pubkey);
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
  rows = [{ pubkey: "c".repeat(64), name: "C" }, a];
  await act(() => agentChoices.refresh());
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
});

it("a read begun before the delete can't bring the deleted main agent back", async () => {
  const a = { pubkey: "a".repeat(64), name: "A" };
  const b = { pubkey: "b".repeat(64), name: "B" };
  let rows = [b, a];
  let release: (() => void) | undefined;
  let hold = false;
  const library = createAgentLibrary(async () => {
    const captured = rows;
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return { definitions: [], identities: captured };
  });
  const agentChoices = createAgentChoices({
    scope: `https://relay.example.test:${"f".repeat(64)}`,
    library: library.queries,
    signal: new AbortController().signal,
  });
  await library.queries.refresh();
  const session = {
    agentChoices,
    channels: noChannels,
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "held")?.name}
      </output>
    );
  }
  render(<Selection />);
  act(() => {
    setDefaultAgent("held", b.pubkey);
  });
  // A read that captured B is still in flight when B is deleted.
  hold = true;
  const stale = library.queries.refresh();
  await act(async () => {});
  hold = false;
  rows = [a];
  await act(async () => {
    await agentChoices.refresh(true, { fresh: true });
    forgetDefaultAgent(b.pubkey);
  });
  await act(async () => {
    release?.();
    await stale;
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
  rows = [{ pubkey: "c".repeat(64), name: "C" }, a];
  await act(() => agentChoices.refresh());
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
});

function accountSession(saved: string | null | undefined) {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  const choices = {
    status: "ready",
    complete: true,
    selectable: [first, second],
    archives: { status: "unavailable", archived: [] },
  };
  let read!: (value: string | null | undefined) => void;
  const account = {
    read: vi.fn(
      () =>
        new Promise<string | null | undefined>((resolve) => {
          read = resolve;
        }),
    ),
    write: vi.fn(async (agent: string) => {
      saved = agent;
    }),
    forget: vi.fn(async (agent: string) => {
      if (saved === agent) saved = null;
    }),
    saved: () => saved,
    resolve: () => read(saved),
  };
  const session = {
    mainAgent: account,
    channels: noChannels,
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output>{useDefaultAgent(session, "account")?.name ?? "none"}</output>
    );
  }
  return { account, session, Selection };
}

it("adopts the account's main agent before any automatic pick on a new install", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
  expect(account.write).not.toHaveBeenCalled();
});

it("a choice cached on this device waits for the account's before it's shown", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("keeps automatic picks on the device and saves explicit choices to the account", async () => {
  const { account, session, Selection } = accountSession(undefined);
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.write).not.toHaveBeenCalled();
  await act(() => chooseDefaultAgent(session, "account", "b".repeat(64)));
  expect(screen.getByRole("status").textContent).toBe("Second");
  expect(account.saved()).toBe("b".repeat(64));
  await act(async () => forgetDefaultAgent("a".repeat(64), session));
  expect(account.saved()).toBe("b".repeat(64));
  await act(async () => forgetDefaultAgent("b".repeat(64), session));
  expect(account.saved()).toBeNull();
});

it("a choice made while the account is read wins, even when already cached", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.saved()).toBe("a".repeat(64));
});

it("still picks a main agent when the account can't be read", async () => {
  const { account, Selection } = accountSession(undefined);
  account.read.mockRejectedValueOnce(new Error("offline"));
  render(<Selection />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("picks the agent from the most recently active Solo chat, once chats are read", () => {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: false };
  const third = { pubkey: "c".repeat(64), name: "Third", managed: true };
  let list: unknown = { status: "loading", channels: [] };
  const listeners = new Set<() => void>();
  const choices = {
    status: "ready",
    complete: true,
    selectable: [first, second, third],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    channels: {
      ensureList: () => {},
      subscribeList: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      list: () => list,
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output>{useDefaultAgent(session, "recent")?.name ?? "none"}</output>
    );
  }
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  act(() => {
    list = {
      status: "ready",
      activityStatus: "ready",
      channels: [
        {
          id: "old",
          channelType: "solo",
          lastActivityAt: 1,
          members: [first.pubkey],
        },
        {
          id: "team",
          channelType: "stream",
          lastActivityAt: 9,
          members: [first.pubkey],
        },
        {
          id: "gone",
          channelType: "solo",
          archived: true,
          lastActivityAt: 8,
          members: [first.pubkey],
        },
        {
          id: "new",
          channelType: "solo",
          lastActivityAt: 5,
          members: [second.pubkey, third.pubkey],
        },
      ],
    };
    for (const notify of listeners) notify();
  });
  expect(screen.getByRole("status").textContent).toBe("Third");
});
