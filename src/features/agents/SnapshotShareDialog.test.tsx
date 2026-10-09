// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render as rtlRender,
  type RenderOptions,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { OutgoingEvent, OutboxRecovery } from "../relay/outbox";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import { createAgentChoices } from "./choices";
import { copySnapshotLink } from "./snapshot-link";
import { SnapshotShareDialog } from "./SnapshotShareDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const render = (ui: ReactElement, options?: RenderOptions) =>
  rtlRender(ui, { wrapper: ToastProvider, ...options });

function fixture(kind: "agent" | "team" = "agent") {
  Element.prototype.scrollIntoView = vi.fn();
  const viewer = "f".repeat(64);
  const authority = "a".repeat(64);
  const recipient = "b".repeat(64);
  const library = { status: "ready", identities: [] };
  let operations: readonly OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let delivery: "unknown" | "failed" | "accepted" = "unknown";
  const outbox = {
    snapshot: () => operations,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: vi.fn(async () => {}),
    acknowledge: vi.fn(async () => {
      operations = [];
      changed();
    }),
    dismiss: vi.fn(async () => {
      operations = [];
      changed();
    }),
  };
  const directMessages = {
    available: true,
    people: vi.fn(async () => ({
      people: [
        { name: "Authority", pubkey: authority },
        { name: "Receiver", pubkey: recipient },
      ],
      hasMore: false,
    })),
    open: vi.fn(async () => "conversation"),
    delivered: vi.fn(async () => {
      delivery = "accepted";
    }),
    delivery: () => delivery,
  };
  const session = {
    viewer,
    relayAuthor: authority,
    directMessages,
    channels: { list: () => ({ channels: [] }) },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    media: (url: string) => url,
    profiles: { snapshot: () => new Map() },
    outbox,
    messages: {
      send: vi.fn(
        (
          channelId: string,
          _content: string,
          _mentions: readonly string[],
          _attachments: unknown,
          recovery?: OutboxRecovery,
        ) => {
          operations = [
            {
              event: {
                id: "receipt",
                kind: 9,
                content: "",
                pubkey: viewer,
                created_at: 1,
                tags: [["h", channelId]],
              },
              recovery,
              delivery: "unknown",
            },
          ];
          changed();
          return "receipt";
        },
      ),
    },
    attachments: {
      upload: vi.fn(async () => ({ url: "https://relay.example/snapshot" })),
    },
  } as unknown as RelaySession;
  Object.assign(session, {
    agentChoices: createAgentChoices({
      scope: `https://relay.example:${viewer}`,
      library: session.agentLibrary,
      signal: new AbortController().signal,
    }),
  });
  const props = {
    session,
    displayName: "Worker",
    sourceId: "worker-source",
    hasMemoryOptions: true,
    snapshotKind: kind,
    excludedPubkeys: [],
    open: true,
    onOpenChange: vi.fn(),
    encodeSnapshot: vi.fn(async (_level: string) => ({
      fileBytes: [1, 2],
      fileName: "worker.png",
    })),
    copyLink: vi.fn(async (snapshot: Promise<unknown>, signal: AbortSignal) => {
      await snapshot;
      signal.throwIfAborted();
    }),
    onExport: vi.fn(),
    catalog: {
      shared: false,
      description:
        "Anyone in this community can find and use a copy. Your agent instruction is shared as plaintext. Memories and secrets aren’t included.",
      setShared: vi.fn(async () => {}),
    },
  };
  return {
    props,
    session,
    directMessages,
    recipient,
    outbox,
    setDelivery: (next: typeof delivery) => {
      delivery = next;
      operations = operations.map((item) => ({ ...item, delivery: next }));
      changed();
    },
  };
}

it.each(["agent", "team"] as const)(
  "starts %s config-only and resets each opening",
  async (kind) => {
    const f = fixture(kind);
    const user = userEvent.setup();
    const view = render(<SnapshotShareDialog {...f.props} />);
    expect(
      screen.getByRole("dialog", { name: "Share Worker" }),
    ).toHaveTextContent(
      `Anyone you share this ${kind} with will receive a copy they can add and use. Changes you make later won’t sync.`,
    );
    const recipients = screen.getByRole("combobox", {
      name: "Message recipients",
    });
    expect(recipients).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox", { name: "People" })).toBeNull();
    await user.click(recipients);
    expect(recipients).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("option", { name: /Receiver/ }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(recipients).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(f.props.copyLink).toHaveBeenCalledTimes(1));
    expect(f.props.encodeSnapshot).toHaveBeenCalledWith(
      "none",
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Export ${kind}` }));
    expect(f.props.onExport).toHaveBeenCalledOnce();
    view.rerender(<SnapshotShareDialog {...f.props} open={false} />);
    view.rerender(<SnapshotShareDialog {...f.props} />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(f.props.encodeSnapshot).toHaveBeenCalledTimes(2),
    );
  },
);

it("does not read or share memory until the explicit plaintext confirmation", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "What to include" }),
    ).toBeEnabled(),
  );
  screen.getByRole("combobox", { name: "What to include" }).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("option", { name: "Agent + core memory" }),
  );
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  const alert = screen.getByRole("alertdialog", { name: "Share memories?" });
  expect(alert).toHaveTextContent(
    "This agent includes plaintext core memory. Anyone with the link can view it. Only share with people you trust.",
  );
  expect(f.props.encodeSnapshot).not.toHaveBeenCalled();
  await user.click(within(alert).getByRole("button", { name: "Cancel" }));
  expect(f.props.copyLink).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Copy link",
    }),
  );
  await waitFor(() => expect(f.props.copyLink).toHaveBeenCalledOnce());
  expect(f.props.encodeSnapshot).toHaveBeenCalledWith(
    "core",
    expect.any(AbortSignal),
  );
});

it("excludes relay authority and retains the exact uncertain-send receipt", async () => {
  const f = fixture();
  f.directMessages.delivered.mockRejectedValueOnce(
    new Error("Unknown receipt"),
  );
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  expect(
    screen.queryByRole("option", { name: /Authority/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send agent. Try again.",
  );
  await user.click(screen.getByRole("button", { name: "Retry send" }));
  expect(await screen.findByText("Sent a copy of Worker")).toHaveTextContent(
    "Sent a copy of Worker",
  );
  expect(f.session.messages.send).toHaveBeenCalledOnce();
  expect(f.props.encodeSnapshot).toHaveBeenCalledOnce();
  expect(f.session.attachments?.upload).toHaveBeenCalledOnce();
  expect(f.directMessages.delivered).toHaveBeenCalledTimes(2);
  expect(f.props.catalog.setShared).not.toHaveBeenCalled();
});

it("catalog and export do not use the memory-bearing delivery encoder", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(screen.getByRole("switch", { name: "Share to catalog" }));
  await waitFor(() =>
    expect(f.props.catalog.setShared).toHaveBeenCalledWith(true),
  );
  await user.click(screen.getByRole("button", { name: "Export agent" }));
  expect(f.props.onExport).toHaveBeenCalledOnce();
  expect(f.props.encodeSnapshot).not.toHaveBeenCalled();
  expect(f.session.messages.send).not.toHaveBeenCalled();
});

it("confirms memory for named recipients before submitting a team", async () => {
  const f = fixture("team");
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "What to include" }),
    ).toBeEnabled(),
  );
  screen.getByRole("combobox", { name: "What to include" }).focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("option", { name: "Team + all memories" }),
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  const alert = screen.getByRole("alertdialog");
  expect(alert).toHaveTextContent(
    "This team includes plaintext all memories. Receiver—and anyone with the file link—can view it. Only share with people you trust.",
  );
  expect(f.session.messages.send).not.toHaveBeenCalled();
  expect(f.props.encodeSnapshot).not.toHaveBeenCalled();
  await user.click(within(alert).getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent a copy of Worker")).toHaveTextContent(
    "Sent a copy of Worker",
  );
  expect(f.props.encodeSnapshot).toHaveBeenCalledWith(
    "everything",
    expect.any(AbortSignal),
  );
});

it("releases failed encoding from the opening cache", async () => {
  const f = fixture();
  f.props.encodeSnapshot.mockRejectedValueOnce(new Error("Memory unavailable"));
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t copy link. Try again.",
  );
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(f.props.copyLink).toHaveBeenCalledTimes(2));
  expect(f.props.encodeSnapshot).toHaveBeenCalledTimes(2);
});

it("blocks duplicate actions while encoding and cancels before delivery on unmount", async () => {
  const f = fixture();
  let release!: (value: { fileBytes: number[]; fileName: string }) => void;
  f.props.encodeSnapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const user = userEvent.setup();
  const view = render(<SnapshotShareDialog {...f.props} />);
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(f.props.encodeSnapshot).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export agent" })).toBeDisabled();
  view.unmount();
  await act(async () => {
    release({ fileBytes: [1], fileName: "worker.png" });
  });
  expect(f.props.copyLink).toHaveBeenCalledOnce();
});

it.each(["reopen", "remount"])(
  "recovers uncertain sends on %s without submitting another event",
  async (mode) => {
    const f = fixture();
    f.directMessages.delivered.mockRejectedValueOnce(
      new Error("Unknown receipt"),
    );
    const user = userEvent.setup();
    let view = render(<SnapshotShareDialog {...f.props} />);
    await user.click(
      screen.getByRole("combobox", { name: "Message recipients" }),
    );
    await user.click(await screen.findByRole("option", { name: /Receiver/ }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    const recovery = f.outbox.snapshot()[0]?.recovery;
    expect(recovery?.value).not.toContain("fileBytes");
    if (mode === "reopen") {
      view.rerender(<SnapshotShareDialog {...f.props} open={false} />);
      view.rerender(<SnapshotShareDialog {...f.props} />);
    } else {
      view.unmount();
      view = render(<SnapshotShareDialog {...f.props} />);
    }
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry send" })).toBeEnabled(),
    );
    expect(
      screen.getByRole("combobox", { name: "What to include" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Retry the earlier message to confirm its delivery before editing.",
    );
    await user.click(screen.getByRole("button", { name: "Retry send" }));
    await screen.findByText("Sent a copy of Worker");
    expect(f.session.messages.send).toHaveBeenCalledOnce();
    expect(f.session.attachments?.upload).toHaveBeenCalledOnce();
    expect(f.props.encodeSnapshot).toHaveBeenCalledOnce();
    expect(f.outbox.acknowledge).toHaveBeenCalledWith("receipt");
    expect(f.props.onOpenChange).toHaveBeenCalledWith(false);
    view.unmount();
  },
);

it("dismisses a terminal failure before applying an option edit", async () => {
  const f = fixture();
  f.directMessages.delivered.mockImplementationOnce(async () => {
    f.setDelivery("failed");
    throw new Error("Rejected");
  });
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  let release!: () => void;
  f.outbox.dismiss.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await user.click(screen.getByRole("combobox", { name: "What to include" }));
  await user.click(
    await screen.findByRole("option", { name: "Agent + core memory" }),
  );
  await waitFor(() => expect(f.outbox.dismiss).toHaveBeenCalledWith("receipt"));
  expect(
    screen.getByRole("combobox", { name: "What to include" }),
  ).toHaveTextContent("Agent only");
  await act(async () => {
    release();
  });
  expect(
    screen.getByRole("combobox", { name: "What to include" }),
  ).toHaveTextContent("Agent + core memory");
});

it("retains the failed receipt and original options if dismissal fails", async () => {
  const f = fixture();
  f.directMessages.delivered.mockImplementationOnce(async () => {
    f.setDelivery("failed");
    throw new Error("Rejected");
  });
  f.outbox.dismiss.mockRejectedValueOnce(new Error("Storage failed"));
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("combobox", { name: "What to include" }));
  await user.click(
    await screen.findByRole("option", { name: "Agent + core memory" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t dismiss the earlier send",
  );
  expect(
    screen.getByRole("combobox", { name: "What to include" }),
  ).toHaveTextContent("Agent only");
  await user.click(screen.getByRole("button", { name: "Retry send" }));
  await screen.findByText("Sent a copy of Worker");
  expect(f.session.messages.send).toHaveBeenCalledOnce();
});

it("hides memory options for a definition without a linked agent", async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} hasMemoryOptions={false} />);
  expect(
    screen.queryByRole("combobox", { name: "What to include" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() =>
    expect(f.props.encodeSnapshot).toHaveBeenCalledWith(
      "none",
      expect.any(AbortSignal),
    ),
  );
});

it("invokes copy synchronously with unresolved encoding data", async () => {
  const f = fixture();
  let release!: (value: { fileBytes: number[]; fileName: string }) => void;
  f.props.encodeSnapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Copy link" }));
  expect(f.props.copyLink).toHaveBeenCalledOnce();
  expect(f.props.copyLink.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  expect(screen.getByRole("button", { name: "Copying…" })).toBeDisabled();
  await act(async () => {
    release({ fileBytes: [1], fileName: "worker.agent.png" });
  });
  expect(screen.getByRole("button", { name: "Copied" })).toBeEnabled();
});

it("resets copied feedback at the reference 1500 ms boundary", async () => {
  const f = fixture();
  render(<SnapshotShareDialog {...f.props} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled(),
  );
  vi.useFakeTimers();
  try {
    await act(async () => {
      screen.getByRole("button", { name: "Copy link" }).click();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeEnabled();
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeEnabled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});

it("recovers a receipt when unmounted during delivery acceptance", async () => {
  const f = fixture();
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  f.directMessages.delivered.mockImplementationOnce(async () => {
    began();
    return new Promise(() => {});
  });
  const user = userEvent.setup();
  const first = render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await started;
  first.unmount();
  render(<SnapshotShareDialog {...f.props} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry send" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Retry send" }));
  await screen.findByText("Sent a copy of Worker");
  expect(f.session.messages.send).toHaveBeenCalledOnce();
  expect(f.props.encodeSnapshot).toHaveBeenCalledOnce();
});

it("allows confirmation-only retry when delivery succeeds but acknowledgement fails", async () => {
  const f = fixture();
  f.outbox.acknowledge.mockRejectedValueOnce(new Error("Storage failed"));
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send agent",
  );
  expect(f.props.onOpenChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Retry send" }));
  await screen.findByText("Sent a copy of Worker");
  expect(f.session.messages.send).toHaveBeenCalledOnce();
  expect(f.outbox.acknowledge).toHaveBeenCalledTimes(2);
});

it("does not enable fresh sends before journal hydration completes", async () => {
  const f = fixture();
  let release!: () => void;
  f.outbox.ready.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  render(<SnapshotShareDialog {...f.props} />);
  expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  expect(
    screen.getByRole("combobox", { name: "What to include" }),
  ).toBeDisabled();
  await act(async () => {
    release();
  });
  expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
});

it.each(["construction", "write", "rejection"])(
  "cancels pending copy data after clipboard %s failure and close",
  async (failure) => {
    const f = fixture();
    let release!: (value: { fileBytes: number[]; fileName: string }) => void;
    f.props.encodeSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const upload = vi.fn(async () => ({
      name: "worker.agent.png",
      url: "https://relay.example/snapshot",
      type: "image/png",
      size: 2,
      sha256: "a".repeat(64),
    }));
    const write = vi.fn(() => {
      if (failure === "write") throw new Error("Denied");
      return Promise.reject(new Error("Denied"));
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor() {
          if (failure === "construction") throw new Error("Denied");
        }
      },
    );
    f.props.copyLink.mockImplementation((snapshot, signal) =>
      copySnapshotLink({
        session: { snapshotUpload: { upload } },
        snapshot: snapshot as Parameters<
          typeof copySnapshotLink
        >[0]["snapshot"],
        displayName: "Worker",
        signal,
      }),
    );
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });
    const view = render(<SnapshotShareDialog {...f.props} />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "What to include" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("combobox", { name: "What to include" }));
    await user.click(
      await screen.findByRole("option", { name: "Agent + core memory" }),
    );
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Copy link",
      }),
    );
    await screen.findByRole("alert");
    expect(f.props.copyLink.mock.calls[0]?.[1].aborted).toBe(true);
    view.unmount();
    await act(async () => {
      release({ fileBytes: [1, 2], fileName: "worker.agent.png" });
    });
    expect(upload).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "acknowledges an accepted restored send (storage failure: %s)",
  async (fails) => {
    const f = fixture();
    f.directMessages.delivered.mockRejectedValueOnce(new Error("Unknown"));
    const user = userEvent.setup();
    const view = render(<SnapshotShareDialog {...f.props} />);
    await user.click(
      screen.getByRole("combobox", { name: "Message recipients" }),
    );
    await user.click(await screen.findByRole("option", { name: /Receiver/ }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    view.rerender(<SnapshotShareDialog {...f.props} open={false} />);
    f.setDelivery("accepted");
    if (fails) f.outbox.acknowledge.mockRejectedValueOnce(new Error("Storage"));
    view.rerender(<SnapshotShareDialog {...f.props} />);
    await waitFor(() =>
      expect(f.outbox.acknowledge).toHaveBeenCalledWith("receipt"),
    );
    if (fails) {
      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: "Retry send" }));
      await screen.findByText("Sent a copy of Worker");
      expect(f.outbox.acknowledge).toHaveBeenCalledTimes(2);
    } else {
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "What to include" }),
        ).toBeEnabled(),
      );
      expect(
        screen.queryByRole("button", { name: "Retry send" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(f.props.onOpenChange).not.toHaveBeenCalled();
    }
    expect(f.session.messages.send).toHaveBeenCalledOnce();
    expect(f.props.encodeSnapshot).toHaveBeenCalledOnce();
  },
);

it("does not show recovery instructions during a fresh in-flight send", async () => {
  const f = fixture();
  let release!: () => void;
  f.directMessages.delivered.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(f.directMessages.delivered).toHaveBeenCalledOnce(),
  );
  try {
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      release();
    });
  }
  await screen.findByText("Sent a copy of Worker");
});

it("shows no recovery instructions or retry label while accepted delivery is acknowledged", async () => {
  const f = fixture();
  let release!: () => void;
  const acknowledge = f.outbox.acknowledge.getMockImplementation();
  if (!acknowledge) throw new Error("Acknowledgement fixture is missing");
  f.outbox.acknowledge.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await acknowledge();
  });
  const user = userEvent.setup();
  render(<SnapshotShareDialog {...f.props} />);
  await user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await user.click(await screen.findByRole("option", { name: /Receiver/ }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(f.outbox.acknowledge).toHaveBeenCalledOnce());
  try {
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry send" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(f.props.onOpenChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release();
    });
  }
  await screen.findByText("Sent a copy of Worker");
  expect(f.props.onOpenChange).toHaveBeenCalledWith(false);
});
