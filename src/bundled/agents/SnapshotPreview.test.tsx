// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import type { AgentControl } from "../../features/agents/control";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
} from "../../features/agents/snapshot";
import { encodeTeam } from "../../features/agents/team-encoding";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import { SnapshotAttachment } from "../../features/messages/SnapshotAttachment";
import { SnapshotPreview } from "./SnapshotPreview";
import { requestSnapshotLinkPreview } from "../../features/agents/snapshot-preview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fixture(kind: "agent" | "team") {
  vi.stubGlobal("crypto", webcrypto);
  const agent = controlFixture().agent;
  agent.harness.command = "buzz-agent";
  agent.harness.environmentKeys = [];
  agent.sessionPolicy = "thread";
  const portable = buildAgentSnapshot(agent);
  const team: TeamSnapshot = {
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: "Controlled team", instructions: "Team instruction" },
    members: [portable],
  };
  const bytes =
    kind === "agent"
      ? encodeAgentSnapshot(portable, "png")
      : new Uint8Array(await encodeTeam(team, "png").arrayBuffer());
  const hash = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const url = `https://relay.example/media/${hash}.png`;
  const attachment = {
    url,
    kind: "image" as const,
    name: `Controlled.${kind}.png`,
  };
  const fetcher = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetcher);
  const viewer = "ef".repeat(32);
  const create = vi.fn(async () => ({
    ...agent,
    id: "independent",
    pubkey: "cd".repeat(32),
  }));
  const writeSnapshotMemory = vi.fn();
  const previewTeam = vi.fn(async () => team);
  const control = {
    create,
    writeSnapshotMemory,
    previewTeam,
    refresh: vi.fn(async () => {}),
    snapshot: () => ({
      data: {
        harnessOptions: [
          { command: "buzz-agent", available: true, defaultArgs: [] },
        ],
        defaultWorkspace: "/recipient-local",
      },
    }),
  } as unknown as AgentControl;
  const session = {
    viewer,
    scope: `https://relay.example:${viewer}`,
    media: () => `buzz-media://localhost/${encodeURIComponent(url)}`,
  } as unknown as RelaySession;
  const connection = { status: "ready", session, scope: session.scope };
  const disconnected = { status: "idle" };
  const listeners = new Set<() => void>();
  let connected = true;
  const relay = {
    snapshot: () => (connected ? connection : disconnected),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  const tree = (
    <>
      <SnapshotPreview relay={relay} control={control} />
      <SnapshotAttachment
        attachment={attachment}
        session={session}
        cached={false}
      />
    </>
  );
  return {
    tree,
    session,
    url,
    disconnect: () => {
      connected = false;
      for (const listener of listeners) listener();
    },
    create,
    writeSnapshotMemory,
    previewTeam,
    fetcher,
    viewer,
    agent,
  };
}

it("clicking a received agent opens the existing preview and only Import requests creation with recipient-local configuration", async () => {
  const h = await fixture("agent");
  render(h.tree);
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.create.mock.calls[0]).toEqual([
    expect.any(String),
    "https://relay.example",
    h.viewer,
    expect.objectContaining({
      name: h.agent.name,
      workspace: "/recipient-local",
      environment: {},
    }),
  ]);
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("clicking a received team validates bytes and opens the existing member preview without mutations", async () => {
  const h = await fixture("team");
  render(h.tree);
  fireEvent.click(screen.getByRole("button", { name: "Add team" }));
  expect(await screen.findByText("Team instruction")).toBeVisible();
  expect(screen.getByText("Help with the project.")).toBeVisible();
  expect(h.previewTeam).toHaveBeenCalledOnce();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(h.create).not.toHaveBeenCalled();
});

it("retires an in-flight preview when the session disconnects", async () => {
  const h = await fixture("team");
  let resolve!: (value: TeamSnapshot) => void;
  const pending = new Promise<TeamSnapshot>((done) => {
    resolve = done;
  });
  h.previewTeam.mockImplementation(() => pending);
  render(h.tree);
  fireEvent.click(screen.getByRole("button", { name: "Add team" }));
  await waitFor(() => expect(h.previewTeam).toHaveBeenCalledOnce());
  act(() => h.disconnect());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => {
    resolve({
      format: "buzz-team-snapshot",
      version: 1,
      team: { name: "Late team", instructions: "Must not open" },
      members: [],
    });
    await pending;
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("cancels the authenticated read on preview dismissal without importing", async () => {
  const h = await fixture("agent");
  let signal: AbortSignal | undefined;
  h.fetcher.mockImplementation((_source?: unknown, options?: RequestInit) => {
    signal = options?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal?.reason), {
        once: true,
      });
    });
  });
  render(h.tree);
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  await waitFor(() => expect(h.fetcher).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(h.create).not.toHaveBeenCalled();
});

it.each(["agent", "team"] as const)(
  "opens a copied %s media link in its existing preview without creating",
  async (kind) => {
    const h = await fixture(kind);
    render(h.tree);
    act(() => requestSnapshotLinkPreview(h.session, h.url));
    expect(await screen.findByText("Help with the project.")).toBeVisible();
    if (kind === "team")
      expect(screen.getByText("Team instruction")).toBeVisible();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "agent",
    JSON.stringify({ format: "buzz-agent-snapshot", version: 99 }),
    "Unsupported snapshot version.",
  ],
  [
    "ordinary JSON",
    JSON.stringify({ name: "not a snapshot" }),
    "Unsupported snapshot format.",
  ],
] as const)(
  "classifies bare %s links before parsing",
  async (_kind, content, error) => {
    const h = await fixture("agent");
    const bytes = new TextEncoder().encode(content);
    const hash = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    h.fetcher.mockImplementation(async () => new Response(bytes));
    render(h.tree);
    act(() =>
      requestSnapshotLinkPreview(
        h.session,
        `https://relay.example/media/${hash}.json`,
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(h.previewTeam).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  },
);
it("ordinary PNG media is not sent to either importer", async () => {
  const h = await fixture("agent");
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAaX1ZFcAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  const hash = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  h.fetcher.mockImplementation(async () => new Response(bytes));
  render(h.tree);
  act(() =>
    requestSnapshotLinkPreview(
      h.session,
      `https://relay.example/media/${hash}.png`,
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unsupported snapshot format.",
  );
  expect(h.previewTeam).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
});
