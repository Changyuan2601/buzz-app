// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import {
  createReminders,
  type Reminder,
  type Reminders,
} from "../../features/relay/reminders";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import userEvent from "@testing-library/user-event";
import { RemindersPage } from "./RemindersPage";
import { apply } from "./index";

afterEach(cleanup);

const viewer = "v";
const now = 1_000_000;
const reminder = (
  id: string,
  status: Reminder["status"],
  createdAt: number,
  notBefore?: number,
): Reminder => ({
  id,
  eventId: `${id}-event`,
  createdAt,
  status,
  ...(notBefore !== undefined ? { notBefore } : {}),
  target: {
    eventId: `${id}-message`,
    channelId: "c",
    preview: id,
    authorPubkey: "a",
  },
});

it("lists finished reminders newest first in a Done group with only Open", () => {
  const state = {
    status: "ready" as const,
    reminders: [
      reminder("overdue item", "pending", 1, now - 60),
      reminder("older done", "done", 10),
      reminder("newer done", "done", 20),
      reminder("cancelled item", "cancelled", 30),
    ],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    complete: vi.fn(),
  } as unknown as Reminders;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const open = vi.fn(() => Promise.resolve({ status: "opened" }));
  render(
    <RemindersPage
      relay={relay}
      navigator={{ open } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  const done = screen.getByText("Done · 2").closest("details");
  assert(done);
  expect(done.open).toBe(false);
  // Done sits below the active sections.
  expect(
    screen
      .getByRole("region", { name: "Overdue" })
      .compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText("newer done")).not.toBeVisible();
  fireEvent.click(within(done).getByText("Done · 2"));
  expect(done.open).toBe(true);
  expect(
    within(done)
      .getAllByRole("listitem")
      .map((row) => row.querySelector("p")?.textContent),
  ).toEqual(["newer done", "older done"]);
  expect(
    within(done)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["Open", "Open"]);
  expect(screen.queryByText("cancelled item")).toBeNull();
  fireEvent.click(
    within(done).getAllByRole("button", { name: "Open" })[0] as HTMLElement,
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "newer done-message" }),
  );
});

it("recovers a failed first history read through Retry, then notifies", async () => {
  vi.useFakeTimers({ now: now * 1000 });
  try {
    const live = {
      id: "live",
      pubkey: viewer,
      kind: 30300,
      created_at: now,
      tags: [
        ["d", "live"],
        ["not_before", String(now + 3)],
      ],
      content: JSON.stringify({ note: "stand-up", status: "pending" }),
      sig: "",
    } as unknown as RelayEvent;
    const query = vi
      .fn<() => Promise<RelayEvent[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);
    const model = createReminders({
      viewer,
      signal: new AbortController().signal,
      host: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: vi.fn(),
      },
      query,
      publish: async () => {},
    });
    const connection = {
      status: "ready",
      scope: `https://community.example:${viewer}`,
      viewer,
      session: {
        reminders: model.capability,
        channels: {
          list: () => ({ status: "ready", channels: [] }),
        },
        live: {
          subscribe: () => () => {},
          snapshot: () => ({ roster: { state: "verified" } }),
        },
      },
    };
    const submit = vi.fn(() => Promise.resolve());
    let Page: () => ReactNode = () => null;
    apply({
      relay: { snapshot: () => connection, subscribe: () => () => {} },
      notifications: { register: () => ({ submit }) },
      pages: {
        register: (page: { component: () => ReactNode }) => {
          Page = page.component;
        },
      },
      navigation: {},
      conversation: { registerMessageAction: vi.fn() },
      effect: (body: () => void) => body(),
    } as unknown as Parameters<typeof apply>[0]);
    render(<Page />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const retry = screen.getByRole("button", { name: "Retry reminders" });
    act(() => model.receive([live]));
    await act(() => vi.advanceTimersByTimeAsync(0));
    // The live arrival fills the list, but history is still incomplete.
    expect(screen.getByText("stand-up")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some reminders could not be loaded.",
    );
    fireEvent.click(retry);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(query).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceKey: `live:${now + 3}` }),
    );
  } finally {
    vi.useRealTimers();
  }
});

function page(list: Reminder[]) {
  const state = { status: "ready" as const, reminders: list };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
  } as unknown as Reminders;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders },
  };
  render(
    <RemindersPage
      relay={
        {
          snapshot: () => connection,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
}

const hint = "Use Remind me in a message's menu to get reminded later.";

it("keeps the Active section with helper text when only Done reminders exist", () => {
  page([reminder("finished", "done", 1)]);
  const active = screen.getByRole("region", { name: "Active" });
  expect(within(active).getByText("No active reminders")).toBeVisible();
  expect(screen.queryByText(hint)).toBeNull();
  expect(screen.getByText("Done · 1")).toBeVisible();
});

it("shows the Active section with the hint and no Done on an empty page", () => {
  page([reminder("cancelled", "cancelled", 1)]);
  const active = screen.getByRole("region", { name: "Active" });
  expect(within(active).getByText("No active reminders")).toBeVisible();
  expect(within(active).getByText(hint)).toBeVisible();
  expect(screen.queryByText(/^Done/)).toBeNull();
});

it.each([
  ["an empty", [] as RelayEvent[], "No active reminders"],
  [
    "a populated",
    [
      {
        id: "kept",
        pubkey: viewer,
        kind: 30300,
        created_at: 1,
        tags: [
          ["d", "kept"],
          ["not_before", String(now + 600)],
        ],
        content: JSON.stringify({ note: "kept note", status: "pending" }),
        sig: "",
      } as unknown as RelayEvent,
    ],
    "kept note",
  ],
])(
  "keeps %s list through a later refresh and offers Retry after it fails",
  async (_, history, visible) => {
    let answer: ((events: RelayEvent[]) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const query = vi.fn(
      () =>
        new Promise<RelayEvent[]>((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    );
    const model = createReminders({
      viewer,
      signal: new AbortController().signal,
      host: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: vi.fn(),
      },
      query,
      publish: async () => {},
    });
    const connection = {
      status: "ready",
      scope: `https://community:${viewer}`,
      viewer,
      session: { reminders: model.capability },
    };
    render(
      <RemindersPage
        relay={
          {
            snapshot: () => connection,
            subscribe: () => () => {},
          } as unknown as RelayData
        }
        navigator={{ open: vi.fn() } as unknown as Navigation}
        clock={{ subscribe: () => () => {}, read: () => now }}
      />,
    );
    const read = (settle: () => void) =>
      act(async () => {
        const done = model.capability.refresh();
        await Promise.resolve();
        settle();
        await done;
      });
    await read(() => answer?.(history));
    // Never connected, so not safe to save, yet the loaded list shows.
    expect(model.capability.snapshot().status).toBe("loading");
    expect(screen.queryByText("Loading reminders…")).toBeNull();
    expect(screen.getByText(visible)).toBeVisible();
    // A refresh in flight, such as reconnect recovery, keeps the list on screen.
    const pending = model.capability.refresh();
    act(() => model.stale());
    expect(screen.queryByText("Loading reminders…")).toBeNull();
    expect(screen.getByText(visible)).toBeVisible();
    await act(async () => {
      fail?.(new Error("offline"));
      await pending;
    });
    const failing = model.capability.refresh();
    await act(async () => {
      fail?.(new Error("offline"));
      await failing;
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some reminders could not be loaded.",
    );
    expect(screen.getByText(visible)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry reminders" }));
    await act(async () => {
      answer?.(history);
      await Promise.resolve();
    });
    await act(() => Promise.resolve());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(visible)).toBeVisible();
  },
);

it("keeps keyboard focus on Retry through a pending and failed read, then hands it to the page", async () => {
  const reads: {
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const model = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: { decode: async () => [], sign: vi.fn() },
    query: () =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        reads.push({ resolve, reject }),
      ),
    publish: async () => {},
  });
  void model.recover();
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders: model.capability },
  };
  render(
    <RemindersPage
      relay={
        {
          snapshot: () => connection,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  await act(async () => reads.shift()?.reject(new Error("offline")));
  const retry = screen.getByRole("button", { name: "Retry reminders" });
  const user = userEvent.setup();
  retry.focus();
  await user.keyboard("{Enter}");
  // Pending: the same control stays, busy and focused.
  expect(retry).toHaveAttribute("aria-busy", "true");
  expect(retry).toHaveFocus();
  await act(async () => reads.shift()?.reject(new Error("offline")));
  expect(retry).not.toHaveAttribute("aria-busy", "true");
  expect(retry).toHaveFocus();
  await user.keyboard("{Enter}");
  await act(async () => reads.shift()?.resolve([]));
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Reminders" }).firstElementChild,
  ).toHaveFocus();
});

type Read = { resolve(events: RelayEvent[]): void; reject(error: Error): void };

/** A recovered store whose every read waits on `reads`. */
function heldStore() {
  const reads: Read[] = [];
  const model = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: { decode: async () => [], sign: vi.fn() },
    query: () =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        reads.push({ resolve, reject }),
      ),
    publish: async () => {},
  });
  void model.recover();
  return { model, reads };
}

/** Mount the page on a failed first read, then start Retry from the keyboard. */
async function pendingRetry() {
  const first = heldStore();
  let reminders = first.model.capability;
  const listeners = new Set<() => void>();
  let connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders },
  };
  render(
    <RemindersPage
      relay={
        {
          snapshot: () => connection,
          subscribe(listener: () => void) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          },
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  await act(async () => first.reads.shift()?.reject(new Error("offline")));
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Retry reminders" }).focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Retry reminders" }),
  ).toHaveAttribute("aria-busy", "true");
  return {
    user,
    /** Settle the first store's pending Retry read. */
    settle: (outcome: "success" | "failure") =>
      act(async () => {
        const read = first.reads.shift();
        if (outcome === "success") read?.resolve([]);
        else read?.reject(new Error("offline"));
      }),
    /** Same community, new session: its store's first read has settled. */
    async swap(outcome: "success" | "failure") {
      const next = heldStore();
      await act(async () => {
        const read = next.reads.shift();
        if (outcome === "success") read?.resolve([]);
        else read?.reject(new Error("offline"));
        reminders = next.model.capability;
        connection = { ...connection, session: { reminders } };
        for (const listener of listeners) listener();
      });
      return next;
    },
  };
}

function elsewhere() {
  const button = document.createElement("button");
  button.textContent = "Community navigation";
  document.body.append(button);
  return button;
}

it("leaves focus where the user moved it when a pending Retry succeeds", async () => {
  const app = await pendingRetry();
  const other = elsewhere();
  try {
    other.focus();
    await app.settle("success");
    expect(
      screen.queryByRole("button", { name: "Retry reminders" }),
    ).toBeNull();
    expect(other).toHaveFocus();
  } finally {
    other.remove();
  }
});

it("shows no stale failure after a swap to a healthy replacement session", async () => {
  const app = await pendingRetry();
  await app.swap("success");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
});

it("lets a failed replacement session retry while the retired Retry is pending", async () => {
  const app = await pendingRetry();
  const next = await app.swap("failure");
  const retry = screen.getByRole("button", { name: "Retry reminders" });
  expect(retry).not.toHaveAttribute("aria-busy", "true");
  expect(retry).toBeEnabled();
  retry.focus();
  await app.user.keyboard("{Enter}");
  expect(retry).toHaveAttribute("aria-busy", "true");
  await act(async () => next.reads.shift()?.resolve([]));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not let the retired session's Retry completion move focus or end a newer Retry", async () => {
  const app = await pendingRetry();
  await app.swap("failure");
  const retry = screen.getByRole("button", { name: "Retry reminders" });
  retry.focus();
  await app.user.keyboard("{Enter}");
  await app.settle("success");
  expect(retry).toHaveFocus();
  expect(retry).toHaveAttribute("aria-busy", "true");
});

/** Renders a control that focuses itself when opened, before the page. */
function withClaim(page: () => ReactNode) {
  let open = false;
  function Claim() {
    const ref = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => {
      if (open) ref.current?.focus();
    });
    return open ? (
      <button type="button" ref={ref}>
        Newly opened control
      </button>
    ) : null;
  }
  const tree = () => (
    <>
      <Claim />
      {page()}
    </>
  );
  return {
    tree,
    open() {
      open = true;
    },
  };
}

function staticPage(connection: () => unknown) {
  return (
    <RemindersPage
      relay={
        {
          snapshot: connection,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      navigator={{ open: vi.fn() } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />
  );
}

it("keeps focus on a control that claims it in the commit that removes Retry", () => {
  // A store that changes only when the test re-renders, so the failure clears
  // and the claim opens in one commit.
  let state: unknown = {
    status: "ready",
    hydrated: true,
    error: "offline",
    reminders: [],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    refresh: async () => {},
  } as unknown as Reminders;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders },
  };
  const claim = withClaim(() => staticPage(() => connection));
  const app = render(claim.tree());
  screen.getByRole("button", { name: "Retry reminders" }).focus();
  state = { status: "ready", hydrated: true, reminders: [] };
  claim.open();
  app.rerender(claim.tree());
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Newly opened control" }),
  ).toHaveFocus();
});

it("keeps focus on a control that claims it as a healthy session replaces a keyboard-started Retry", async () => {
  const first = heldStore();
  await act(async () => first.reads.shift()?.reject(new Error("offline")));
  const next = heldStore();
  await act(async () => next.reads.shift()?.resolve([]));
  let connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders: first.model.capability },
  };
  const claim = withClaim(() => staticPage(() => connection));
  const app = render(claim.tree());
  screen.getByRole("button", { name: "Retry reminders" }).focus();
  const user = userEvent.setup();
  await user.keyboard("{Enter}");
  connection = { ...connection, session: { reminders: next.model.capability } };
  claim.open();
  await act(async () => {
    app.rerender(claim.tree());
  });
  expect(screen.queryByRole("button", { name: "Retry reminders" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Newly opened control" }),
  ).toHaveFocus();
  await act(async () => first.reads.shift()?.resolve([]));
});
