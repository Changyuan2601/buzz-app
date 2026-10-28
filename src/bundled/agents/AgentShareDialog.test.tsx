// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { readSnapshot } from "../../features/agents/agent-share";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { AgentShareDialog } from "./AgentShareDialog";

const desktop = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => desktop.tauri,
  invoke: desktop.invoke,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const owner = "f".repeat(64);
const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config: { instructions: "Review pull requests.", model: "echo-1" },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
};
const echo = {
  key: "test/echo",
  title: "Echo",
  carry: (saved: { instructions: string }) => ({
    instructions: saved.instructions,
  }),
  exportShared: (saved: { model: string }) => ({
    runtime: "echo",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;

/** A community whose catalog holds the heads its outbox accepted. */
function community() {
  const heads: EventData[] = [];
  const listeners = new Set<() => void>();
  let pending: { event: EventData; delivery: string } | undefined;
  const outbox = {
    supports: (kind: number) => kind === 30175,
    ready: async () => {},
    send: vi.fn((input: Pick<EventData, "kind" | "content" | "tags">) => {
      const event = {
        ...input,
        id: String(heads.length + 1).repeat(64),
        pubkey: owner,
        created_at: heads.length + 1,
      } as EventData;
      pending = { event, delivery: "sending" };
      return event.id;
    }),
    snapshot: () => (pending ? [pending] : []),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: vi.fn(async () => {}),
  };
  /** The relay accepts what was sent. */
  const accept = () => {
    if (pending) heads.push(pending.event);
    pending = undefined;
    for (const listener of listeners) listener();
  };
  /** The relay never answers, whether or not it `landed`. */
  const lose = (landed: boolean) => {
    if (!pending) return;
    if (landed) heads.push(pending.event);
    pending = { ...pending, delivery: "unknown" };
    for (const listener of listeners) listener();
  };
  const read = vi.fn(async () => [...heads]);
  return {
    session: {
      read,
      outbox,
      media: (url: string) => url,
    } as unknown as RelaySession,
    heads,
    outbox,
    accept,
    lose,
    read,
  };
}

it("shares the agent to its community's catalog and unshares what it shared", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept } = community();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Share Ada" });
  const toggle = within(dialog).getByRole("switch", {
    name: "Share to catalog",
  });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  const sharedContent = JSON.stringify({
    display_name: "Ada",
    system_prompt: "Review pull requests.",
    acp_command: "buzz-acp",
    runtime: "echo",
    model: "echo-1",
  });
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await within(dialog).findByText("Published Ada to the community catalog."),
  ).toBeInTheDocument();
  expect(toggle).toBeChecked();

  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  // Unsharing replaces the shared head with what it shared.
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [["d", agent.pubkey]],
      supersedes: 1,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await within(dialog).findByText(
      "Ada is no longer discoverable in the community catalog.",
    ),
  ).toBeInTheDocument();
  expect(toggle).not.toBeChecked();
});

it("says why sharing failed and keeps the catalog as it was", async () => {
  const user = userEvent.setup();
  const { session, outbox } = community();
  render(
    <AgentShareDialog
      agent={{
        ...agent,
        config: { instructions: "password: hunter2hunter2", model: "" },
      }}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const toggle = screen.getByRole("switch", { name: "Share to catalog" });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  await user.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to update catalog sharing. Portable configuration appears to contain a credential. Remove it before sharing or exporting.",
  );
  expect(outbox.send).not.toHaveBeenCalled();
  expect(toggle).not.toBeChecked();
});

it("asks the relay what an unanswered publish did before saying it failed", async () => {
  const user = userEvent.setup();
  const { session, outbox, lose } = community();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const toggle = screen.getByRole("switch", { name: "Share to catalog" });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  lose(true);
  expect(
    await screen.findByText("Published Ada to the community catalog."),
  ).toBeInTheDocument();
  expect(toggle).toBeChecked();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  lose(false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to update catalog sharing. Try again.",
  );
  expect(toggle).toBeChecked();
});

it("says unsharing failed when a newer shared head wins over the accepted one", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept, heads } = community();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const toggle = screen.getByRole("switch", { name: "Share to catalog" });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  accept();
  await vi.waitFor(() => expect(toggle).toBeChecked());

  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  // Another device shared it again, later, before this unshare landed.
  const shared = heads[0];
  if (shared) heads.push({ ...shared, id: "9".repeat(64), created_at: 99 });
  accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to update catalog sharing. Try again.",
  );
  expect(toggle).toBeChecked();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("keeps the confirmed state when the relay cannot say which head won", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept, read } = community();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const toggle = screen.getByRole("switch", { name: "Share to catalog" });
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  accept();
  await vi.waitFor(() => expect(toggle).toBeChecked());

  await user.click(toggle);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  read.mockRejectedValueOnce(new Error("offline"));
  accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to update catalog sharing. Try again.",
  );
  expect(toggle).toBeChecked();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("reads the catalog again after the first read fails", async () => {
  const user = userEvent.setup();
  const { session, read } = community();
  read.mockRejectedValueOnce(new Error("offline"));
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const toggle = screen.getByRole("switch", { name: "Share to catalog" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read the community catalog. Check the community connection, then retry.",
  );
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await vi.waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("exports the agent as an .agent.json snapshot", async () => {
  const user = userEvent.setup();
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:snapshot";
    },
    revokeObjectURL: () => {},
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("Ada.agent.json");
      expect(this.href).toBe("blob:snapshot");
    });
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={community().session}
      onClose={() => {}}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "File format" }));
  await user.click(await screen.findByRole("option", { name: "JSON" }));
  await user.click(screen.getByRole("button", { name: "Export agent" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Exported Ada.");
  expect(click).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await blobs[0]?.text()) ?? "")).toEqual({
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: "Ada",
      systemPrompt: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    },
    profile: { displayName: "Ada" },
    memory: { level: "none", entries: [] },
  });
  click.mockRestore();
});

it("names a desktop export so every platform accepts it", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockClear();
  try {
    const names: [string, string][] = [
      ["Con", "Con-agent.agent.png"],
      ["lpt1", "lpt1-agent.agent.png"],
      ["Console", "Console.agent.png"],
      ["x".repeat(128), `${"x".repeat(64)}.agent.png`],
    ];
    for (const [name, file] of names) {
      render(
        <AgentShareDialog
          agent={{ ...agent, name }}
          type={echo}
          session={community().session}
          onClose={() => {}}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Export agent" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Exported");
      expect(desktop.invoke.mock.lastCall?.[2]).toEqual({
        headers: { "x-buzz-file-name": file },
      });
      cleanup();
    }
  } finally {
    desktop.tauri = false;
  }
});

it("exports without the picture when it does not load in time", async () => {
  desktop.tauri = true;
  desktop.invoke.mockClear();
  vi.stubGlobal(
    "Image",
    class {
      decode = () => new Promise(() => {});
    },
  );
  try {
    render(
      <AgentShareDialog
        agent={{ ...agent, picture: "https://media.example/ada.png" }}
        type={echo}
        session={community().session}
        onClose={() => {}}
      />,
    );
    // Only the wait for the picture runs on a controlled clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Export agent" }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(desktop.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Exported Ada.",
    );
    expect(
      await readSnapshot(new Blob([desktop.invoke.mock.calls[0]?.[1]])),
    ).toMatchObject({ name: "Ada", picture: "https://media.example/ada.png" });
  } finally {
    desktop.tauri = false;
    vi.useRealTimers();
  }
});

it("saves an .agent.png natively on desktop, never through a blob link", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockResolvedValueOnce("/Users/ada/Downloads/Ada.agent.png");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
  try {
    render(
      <AgentShareDialog
        agent={agent}
        type={echo}
        session={community().session}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "File format" }),
    ).toHaveTextContent("PNG");
    await user.click(screen.getByRole("button", { name: "Export agent" }));
    // Desktop says where the file went.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Exported Ada to /Users/ada/Downloads/Ada.agent.png.",
    );
    expect(click).not.toHaveBeenCalled();
    expect(desktop.invoke).toHaveBeenCalledOnce();
    const [command, bytes, options] = desktop.invoke.mock.calls[0] ?? [];
    expect(command).toBe("file_download");
    expect(options).toEqual({
      headers: { "x-buzz-file-name": "Ada.agent.png" },
    });
    expect(await readSnapshot(new Blob([bytes]))).toEqual({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    });
  } finally {
    desktop.tauri = false;
    click.mockRestore();
  }
});

it("updates a share older than the agent, keeping it listed", async () => {
  const user = userEvent.setup();
  const { session, heads, outbox, accept } = community();
  heads.push({
    id: "9".repeat(64),
    pubkey: owner,
    created_at: 0,
    kind: 30175,
    tags: [
      ["d", agent.pubkey],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: "Ada", system_prompt: "Old." }),
  });
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Share Ada" });
  expect(
    await within(dialog).findByText(
      "The shared copy is older than this agent.",
    ),
  ).toBeInTheDocument();
  await user.click(
    within(dialog).getByRole("button", { name: "Update share" }),
  );
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: JSON.stringify({
        display_name: "Ada",
        system_prompt: "Review pull requests.",
        acp_command: "buzz-acp",
        runtime: "echo",
        model: "echo-1",
      }),
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
      supersedes: 0,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await within(dialog).findByText("Published Ada to the community catalog."),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "Update share" }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).getByRole("switch", { name: "Share to catalog" }),
  ).toBeChecked();
});
