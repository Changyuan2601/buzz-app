// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  listSharedSessions,
  type SharedSessionPage,
} from "../../features/sessions/shared-sessions";
import { SharedSessions } from "./SharedSessions";

vi.mock("../../features/sessions/shared-sessions", () => ({
  listSharedSessions: vi.fn(),
}));
const list = vi.mocked(listSharedSessions);
const viewer = "a".repeat(64);
const sender = "b".repeat(64);
const entry = {
  id: "source",
  title: "Investigate duplicate notifications",
  sharedAt: 100,
  shares: [{ id: "share", pubkey: sender, createdAt: 100 }],
};
const page: SharedSessionPage = {
  entries: [entry],
  complete: true,
  errors: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const rosterListeners = new Set<() => void>();
  const liveListeners = new Set<Parameters<RelaySession["subscribeLive"]>[0]>();
  let channels: ChannelSummary[] = ["destination", "source", "unrelated"].map(
    (id) => ({
      id,
      name: id,
      members: [viewer, sender],
      visibility: "private",
    }),
  );
  const profileValues = new Map([
    [sender, { name: "Tulsi" }],
    ["c".repeat(64), { name: "Avery" }],
    ["d".repeat(64), { name: "Robin" }],
  ]);
  const session = {
    viewer,
    scope: "scope",
    media: () => undefined,
    channels: {
      list: () => ({ status: "ready", channels }),
      subscribeList: (listener: () => void) => {
        rosterListeners.add(listener);
        return () => rosterListeners.delete(listener);
      },
    },
    profiles: {
      snapshot: () => profileValues,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    subscribeLive: (listener: Parameters<RelaySession["subscribeLive"]>[0]) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
  } as unknown as RelaySession;
  return {
    session,
    grant() {
      channels = [
        ...channels.filter((channel) => channel.id !== "source"),
        {
          id: "source",
          name: "source",
          visibility: "private",
          members: [viewer, sender],
        },
      ];
      for (const listener of rosterListeners) listener();
    },
    mutation() {
      for (const listener of liveListeners)
        listener({
          events: [{ id: "deleted", kind: 5, tags: [["e", "share"]] }],
        } as unknown as Parameters<
          Parameters<RelaySession["subscribeLive"]>[0]
        >[0]);
    },
    legacyShare() {
      for (const listener of liveListeners)
        listener({
          events: [
            {
              id: "legacy",
              kind: 9,
              tags: [["h", "destination"]],
              content: "[Session: Older work](buzz://channel/source)",
            },
          ],
        } as unknown as Parameters<
          Parameters<RelaySession["subscribeLive"]>[0]
        >[0]);
    },
    publicNonmemberSource() {
      channels = channels.filter((channel) => channel.id !== "source");
    },
    renameUnrelated() {
      channels = channels.map((channel) =>
        channel.id === "unrelated" ? { ...channel, name: "renamed" } : channel,
      );
      for (const listener of rosterListeners) listener();
    },
    renameDestination() {
      channels = channels.map((channel) => ({ ...channel, name: "renamed" }));
      for (const listener of rosterListeners) listener();
    },
    revoke() {
      channels = channels.filter((channel) => channel.id !== "source");
      for (const listener of rosterListeners) listener();
    },
  };
}
beforeEach(() => {
  list.mockReset();
});
afterEach(cleanup);

it("refreshes an open list when an unmarked session card arrives", async () => {
  const f = fixture();
  list.mockResolvedValueOnce({ entries: [], complete: true, errors: [] });
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  await screen.findByText("No shared sessions to show");
  list.mockResolvedValue(page);
  act(() => f.legacyShare());
  await screen.findByRole("button", {
    name: /Investigate duplicate notifications/,
  });
});

it("loads, searches, clears and opens a title-first accessible row", async () => {
  const gate = deferred<SharedSessionPage>();
  list.mockReturnValue(gate.promise);
  const open = vi.fn();
  render(
    <SharedSessions
      session={fixture().session}
      channelId="destination"
      open={open}
    />,
  );
  expect(screen.getByText("Loading shared sessions…")).toHaveAttribute(
    "role",
    "status",
  );
  expect(screen.queryByRole("listitem")).toBeNull();
  await act(async () => gate.resolve(page));
  const row = screen.getByRole("button", {
    name: /Investigate duplicate notifications, shared by Tulsi/,
  });
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(row).toHaveAccessibleDescription("Session ID source");
  await userEvent.type(
    screen.getByRole("searchbox", { name: "Search shared sessions" }),
    "another topic",
  );
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.getByText(/No titles or sharers match/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /^Clear search$/ }));
  expect(screen.getByRole("listitem")).toBeVisible();
  expect(list).toHaveBeenCalledTimes(1);
  await userEvent.click(
    screen.getByRole("button", {
      name: /Investigate duplicate notifications, shared by Tulsi/,
    }),
  );
  expect(open).toHaveBeenCalledWith("source");
  expect(
    screen.getByRole("region", { name: "Shared sessions" }),
  ).toHaveAttribute("tabindex", "-1");
});

it("searches every contributing sharer by name, including an earlier sharer", async () => {
  list.mockResolvedValue({
    ...page,
    entries: [
      {
        ...entry,
        shares: [
          ...entry.shares,
          { id: "older", pubkey: "c".repeat(64), createdAt: 90 },
        ],
      },
    ],
  });
  render(
    <SharedSessions
      session={fixture().session}
      channelId="destination"
      open={() => {}}
    />,
  );
  await screen.findByRole("listitem");
  const search = screen.getByRole("searchbox", {
    name: "Search shared sessions",
  });
  expect(search).toHaveAttribute("placeholder", "Search titles or people");
  await userEvent.type(search, "  aVeRy  ");
  expect(screen.getByRole("listitem")).toHaveTextContent("Tulsi and 1 other");
  await userEvent.clear(search);
  await userEvent.type(search, "Tulsi");
  expect(screen.getByRole("listitem")).toBeVisible();
  await userEvent.clear(search);
  await userEvent.type(search, "Robin");
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.getByText(/No titles or sharers match/)).toBeVisible();
  expect(list).toHaveBeenCalledTimes(1);
});

it("keeps read failures distinct from an empty collection and retries", async () => {
  list
    .mockRejectedValueOnce(new Error("private internal failure"))
    .mockResolvedValueOnce(page);
  render(
    <SharedSessions
      session={fixture().session}
      channelId="destination"
      open={() => {}}
    />,
  );
  expect(
    await screen.findByText("Some shared sessions couldn’t be loaded."),
  ).toBeVisible();
  expect(screen.queryByText("No shared sessions to show")).toBeNull();
  expect(screen.queryByText(/private internal/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("listitem")).toBeVisible();
});

it("deduplicates the same source and sharer across catalog pages", async () => {
  list
    .mockResolvedValueOnce({
      ...page,
      complete: false,
      cursor: { until: 100, before_id: "share" },
    })
    .mockResolvedValueOnce({
      ...page,
      entries: [
        {
          ...entry,
          shares: [
            ...entry.shares,
            { id: "other", pubkey: sender, createdAt: 99 },
          ],
        },
      ],
    });
  render(
    <SharedSessions
      session={fixture().session}
      channelId="destination"
      open={() => {}}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Load more" }),
  );
  await screen.findByText("1 session");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByText(/and 1 other/)).toBeNull();
});

it("retires a protected title immediately on access changes and aborts on unmount", async () => {
  const f = fixture();
  const gate = deferred<SharedSessionPage>();
  list.mockResolvedValueOnce(page).mockReturnValueOnce(gate.promise);
  const result = render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={() => {}}
    />,
  );
  await screen.findByRole("listitem");
  act(() => f.revoke());
  expect(screen.queryByText(entry.title)).toBeNull();
  const signal = list.mock.calls.at(-1)?.[2]?.signal;
  result.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => gate.resolve(page));
  expect(screen.queryByText(entry.title)).toBeNull();
});

it("discovers a formerly hidden source when access is granted without a new share", async () => {
  const f = fixture();
  f.revoke();
  list
    .mockResolvedValueOnce({ entries: [], complete: true, errors: [] })
    .mockResolvedValueOnce(page);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={() => {}}
    />,
  );
  await screen.findByText("No shared sessions to show");
  act(() => f.grant());
  expect(await screen.findByRole("listitem")).toBeVisible();
});

it("retains a focused row while refreshing and recovers focus after a reference-only deletion", async () => {
  const f = fixture();
  const gate = deferred<SharedSessionPage>();
  list.mockResolvedValueOnce(page).mockReturnValueOnce(gate.promise);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={() => {}}
    />,
  );
  const row = await screen.findByRole("button", {
    name: /Investigate duplicate/,
  });
  row.focus();
  act(() => f.mutation());
  expect(row).toBeVisible();
  expect(row).toHaveFocus();
  await act(async () =>
    gate.resolve({ entries: [], complete: true, errors: [] }),
  );
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.getByRole("region", { name: "Shared sessions" })).toHaveFocus();
});

it("preserves the first page and retry focus while a failed next page is retried", async () => {
  const f = fixture();
  const cursor = { until: 100, before_id: "share" };
  const gate = deferred<SharedSessionPage>();
  list
    .mockResolvedValueOnce({ ...page, complete: false, cursor })
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(gate.promise);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={() => {}}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Load more" }),
  );
  const retry = await screen.findByRole("button", { name: "Retry" });
  await userEvent.click(retry);
  expect(retry).toHaveFocus();
  expect(screen.getByRole("listitem")).toBeVisible();
  expect(list.mock.calls.at(-1)?.[2]?.cursor).toEqual(cursor);
  await act(async () => gate.resolve(page));
  expect(screen.getByRole("region", { name: "Shared sessions" })).toHaveFocus();
});

it("restores a hidden reference after an unattributed deletion of its edit", async () => {
  const f = fixture();
  list
    .mockResolvedValueOnce({ entries: [], complete: true, errors: [] })
    .mockResolvedValueOnce(page);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={() => {}}
    />,
  );
  await screen.findByText("No shared sessions to show");
  act(() => f.mutation());
  expect(await screen.findByRole("listitem")).toBeVisible();
});

it.each(["Retry", "Load more"])(
  "%s revisits a partial-error batch without losing good rows",
  async (action) => {
    const start = { until: 100, before_id: "a" };
    const advanced = { until: 50, before_id: "b" };
    const partial = { ...entry, id: "partial", title: "Partial result" };
    const recovered = { ...entry, id: "recovered", title: "Recovered result" };
    list
      .mockResolvedValueOnce({ ...page, complete: false, cursor: start })
      .mockResolvedValueOnce({
        entries: [partial],
        cursor: advanced,
        complete: false,
        errors: ["Retry."],
      })
      .mockResolvedValueOnce({
        entries: [partial],
        cursor: advanced,
        complete: false,
        errors: ["Retry."],
      })
      .mockResolvedValueOnce({
        entries: [partial, recovered],
        complete: true,
        errors: [],
      });
    render(
      <SharedSessions
        session={fixture().session}
        channelId="destination"
        open={() => {}}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Load more" }),
    );
    expect(await screen.findByText("Partial result")).toBeVisible();
    expect(screen.getByText(entry.title)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: action }));
    expect(list.mock.calls[2]?.[2]?.cursor).toEqual(start);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: action }));
    expect(list.mock.calls[3]?.[2]?.cursor).toEqual(start);
    expect(await screen.findByText("Recovered result")).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  },
);

it("retries the beginning after a partial-error first page", async () => {
  list
    .mockResolvedValueOnce({
      ...page,
      cursor: { until: 50, before_id: "b" },
      complete: false,
      errors: ["Retry."],
    })
    .mockResolvedValueOnce(page);
  render(
    <SharedSessions
      session={fixture().session}
      channelId="destination"
      open={() => {}}
    />,
  );
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.getByRole("listitem")).toBeVisible();
  await userEvent.click(retry);
  expect(list.mock.calls[1]?.[2]?.cursor).toBeUndefined();
});

it("retains a readable public nonmember source through an unrelated refresh failure", async () => {
  const f = fixture();
  f.publicNonmemberSource();
  const gate = deferred<SharedSessionPage>();
  list.mockResolvedValueOnce(page).mockReturnValueOnce(
    gate.promise.then(() => {
      throw new Error("Unavailable");
    }),
  );
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  const row = await screen.findByRole("button", {
    name: /Investigate duplicate notifications/,
  });
  act(() => f.renameDestination());
  expect(row).toBeInTheDocument();
  await act(async () =>
    gate.resolve({ entries: [], errors: ["Unavailable"], complete: false }),
  );
  expect(row).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("finishes Load more and coalesces live traffic into one trailing refresh", async () => {
  const f = fixture();
  const cursor = { until: 100, before_id: "share" };
  const gate = deferred<SharedSessionPage>();
  const older = { ...entry, id: "older", title: "Older work" };
  const olderPage = { entries: [older], complete: true, errors: [] };
  list
    .mockResolvedValueOnce({ ...page, cursor, complete: false })
    .mockReturnValueOnce(gate.promise)
    .mockResolvedValueOnce({ ...page, cursor, complete: false })
    .mockResolvedValueOnce(olderPage);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Load more" }),
  );
  const signal = list.mock.calls[1]?.[2]?.signal;
  try {
    act(() => {
      f.mutation();
      f.mutation();
      f.legacyShare();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    expect(screen.getByText(entry.title)).toBeVisible();
  } finally {
    await act(async () => gate.resolve(olderPage));
  }
  await screen.findByText("Older work");
  await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
  expect(list.mock.calls[3]?.[2]?.cursor).toEqual(cursor);
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

it.each([
  { query: "   ", cursor: undefined, text: "No shared sessions to show" },
  { query: "missing", cursor: undefined, text: /No titles or sharers match/ },
  {
    query: "",
    cursor: { until: 100, before_id: "share" },
    text: /Older messages remain/,
  },
])(
  "retains the settled $query empty/search state during refresh",
  async ({ query, cursor, text }) => {
    const f = fixture();
    const empty = {
      entries: [],
      errors: [],
      complete: !cursor,
      ...(cursor ? { cursor } : {}),
    };
    const gate = deferred<SharedSessionPage>();
    list.mockResolvedValueOnce(empty).mockReturnValueOnce(gate.promise);
    render(
      <SharedSessions
        session={f.session}
        channelId="destination"
        view={{ query, scrollTop: 0 }}
        open={vi.fn()}
      />,
    );
    const settled = await screen.findByText(text);
    const clear = screen.queryByRole("button", { name: "Clear search" });
    clear?.focus();
    try {
      act(() => f.mutation());
      expect(settled).toBeVisible();
      if (clear) {
        expect(screen.getByRole("button", { name: "Clear search" })).toBe(
          clear,
        );
        expect(clear).toHaveFocus();
      }
      expect(screen.queryByText("Loading shared sessions…")).toBeNull();
      expect(
        screen.queryByText(/unavailable|not available|aren’t available/),
      ).toBeNull();
    } finally {
      await act(async () => gate.resolve(empty));
    }
  },
);

it("ignores unrelated channel renames and never restores a revoked row from a held refresh", async () => {
  const f = fixture();
  const gate = deferred<SharedSessionPage>();
  const trailing = deferred<SharedSessionPage>();
  list
    .mockResolvedValueOnce(page)
    .mockReturnValueOnce(gate.promise)
    .mockReturnValueOnce(trailing.promise);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  await screen.findByText(entry.title);
  act(() => f.renameUnrelated());
  expect(list).toHaveBeenCalledTimes(1);
  act(() => f.mutation());
  act(() => f.revoke());
  expect(screen.queryByText(entry.title)).toBeNull();
  try {
    await act(async () => gate.resolve(page));
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(entry.title)).toBeNull();
  } finally {
    await act(async () => {
      gate.resolve(page);
      trailing.resolve({ entries: [], errors: [], complete: true });
    });
  }
});

it("prioritizes Load more over repeated trailing refreshes without aborting either read", async () => {
  const f = fixture();
  const cursor = { until: 100, before_id: "share" };
  const first = { ...page, complete: false, cursor };
  const olderPage = {
    ...page,
    entries: [{ ...entry, id: "older", title: "Older work" }],
  };
  const refresh = deferred<SharedSessionPage>();
  const trailing = deferred<SharedSessionPage>();
  const more = deferred<SharedSessionPage>();
  list
    .mockResolvedValueOnce(first)
    .mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(trailing.promise)
    .mockReturnValueOnce(more.promise)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(olderPage);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  const button = await screen.findByRole("button", { name: "Load more" });
  try {
    act(() => {
      f.mutation();
      f.mutation();
    });
    await act(async () => refresh.resolve(first));
    expect(list).toHaveBeenCalledTimes(3);
    act(() => {
      f.mutation();
      f.mutation();
    });
    expect(button).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]?.[2]?.signal?.aborted).toBe(false);
    await act(async () => trailing.resolve(first));
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls[3]?.[2]?.cursor).toEqual(cursor);
    expect(button).toHaveAttribute("aria-disabled", "true");
  } finally {
    await act(async () => {
      refresh.resolve(first);
      trailing.resolve(first);
      more.resolve(olderPage);
    });
  }
  await screen.findByText("Older work");
  expect(list).toHaveBeenCalledTimes(6);
});

it("prioritizes Retry over a queued background refresh", async () => {
  const f = fixture();
  const failed = { entries: [], complete: false, errors: ["Unavailable"] };
  const refresh = deferred<SharedSessionPage>();
  const retry = deferred<SharedSessionPage>();
  list
    .mockResolvedValueOnce(failed)
    .mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(retry.promise)
    .mockResolvedValueOnce(page);
  render(
    <SharedSessions
      session={f.session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  const button = await screen.findByRole("button", { name: "Retry" });
  try {
    act(() => {
      f.mutation();
      f.mutation();
    });
    expect(button).toHaveAttribute("aria-disabled", "false");
    await userEvent.click(button);
    await act(async () => refresh.resolve(failed));
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2]?.[2]?.cursor).toBeUndefined();
  } finally {
    await act(async () => {
      refresh.resolve(failed);
      retry.resolve(page);
    });
  }
  expect(await screen.findByText(entry.title)).toBeVisible();
  expect(list).toHaveBeenCalledTimes(4);
});

it("ignores repeated Load more activation while that explicit read is held", async () => {
  const cursor = { until: 100, before_id: "share" };
  const gate = deferred<SharedSessionPage>();
  list
    .mockResolvedValueOnce({ ...page, complete: false, cursor })
    .mockReturnValueOnce(gate.promise);
  render(
    <SharedSessions
      session={fixture().session}
      channelId="destination"
      open={vi.fn()}
    />,
  );
  const button = await screen.findByRole("button", { name: "Load more" });
  await userEvent.click(button);
  try {
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    await userEvent.click(button);
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => gate.resolve(page));
  }
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});
