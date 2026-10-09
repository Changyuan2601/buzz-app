// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDirectShare } from "./DirectShare";
import { controlFixture } from "../../features/agents/control-testing";
import { parseAgentSnapshot } from "../../features/agents/snapshot";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { AgentControl, AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
vi.mock("./CommunityCatalog", () => ({
  AgentShareSwitch: () => null,
  CatalogShareSwitch: () => null,
  teamShareDescription: "",
  buildTeamCatalogContent: vi.fn(),
}));
vi.mock("../../features/direct-messages/RecipientPicker", () => ({
  RecipientPicker: () => null,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function bytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}
function fixture(
  source = "wss://connected.example",
  sessionOrigin = "https://connected.example",
) {
  const agent = {
    ...controlFixture().agent,
    id: `${"a".repeat(64)}-${"b".repeat(64)}`,
    relayUrl: source,
    sessionPolicy: "thread",
    harness: {
      ...controlFixture().agent.harness,
      command: "buzz-agent",
      environmentKeys: [],
    },
  } as AgentView;
  let state = { status: "ready", data: { agents: [agent] }, busy: false };
  const listeners = new Set<() => void>();
  const control = {
    snapshot: () => state,
    subscribe: (f: () => void) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  } as unknown as AgentControl;
  const memoryOpen = vi.fn(() => ({
    refresh: async () => {},
    snapshot: () => ({
      status: "ready",
      listing: {
        partial: false,
        entries: [
          { slug: "core", body: "harmless connected-community marker" },
        ],
      },
    }),
    dispose: vi.fn(),
  }));
  const artifacts: ReturnType<typeof parseAgentSnapshot>[] = [];
  const upload = vi.fn(async (file: File) => {
    artifacts.push(parseAgentSnapshot(await bytes(file)));
    return {
      url: `${sessionOrigin}/media/${"a".repeat(64)}.png`,
      name: file.name,
      size: file.size,
      sha256: "a".repeat(64),
      type: file.type,
    };
  });
  const emptyOperations: unknown[] = [];
  const session = {
    scope: `${sessionOrigin}:${"e".repeat(64)}`,
    viewer: "e".repeat(64),
    outbox: {
      ready: async () => {},
      snapshot: () => emptyOperations,
      subscribe: () => () => {},
    },
    directMessages: { delivery: () => "unknown" },
    agentMemories: { open: memoryOpen },
    snapshotUpload: { upload },
  } as unknown as RelaySession;
  vi.stubGlobal(
    "ClipboardItem",
    class {
      data: Record<string, Promise<Blob>>;
      constructor(data: Record<string, Promise<Blob>>) {
        this.data = data;
      }
    },
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
        await Promise.all(Object.values(items[0]?.data ?? {}));
      }),
    },
  });
  const mounted = render(
    <ToastProvider>
      <AgentDirectShare
        session={session}
        agent={agent}
        control={control}
        name="Fixture agent"
      />
    </ToastProvider>,
  );
  const change = (patch: Partial<AgentView>) =>
    act(() => {
      const current = state.data.agents[0];
      if (!current) throw new Error("Missing fixture agent");
      state = {
        ...state,
        data: { agents: [{ ...current, ...patch }] },
      };
      for (const f of listeners) f();
    });
  return { artifacts, upload, memoryOpen, change, mounted };
}
async function openAndReview() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /I reviewed/ })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
}
async function copy() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await screen.findByRole("button", { name: "Copied" });
}
it("baseline actual PNG contains only portable configuration and no optional memory", async () => {
  const f = fixture();
  await openAndReview();
  await copy();
  expect(f.artifacts).toHaveLength(1);
  const a = f.artifacts[0];
  if (!a) throw new Error("Missing uploaded snapshot");
  expect(a.memory).toEqual({ level: "none", entries: [] });
  expect(f.memoryOpen).not.toHaveBeenCalled();
  for (const forbidden of [
    "fixture-agent",
    "/fixture/workspace",
    "/fixture/bin",
    "environmentKeys",
    "authTag",
    "privateKey",
    "secret-env-value",
  ])
    expect(JSON.stringify(a)).not.toContain(forbidden);
});
it("changing serialized name resets approval and encoding", async () => {
  const f = fixture();
  await openAndReview();
  f.change({ name: "New harmless unreviewed name" });
  expect(
    screen.getByRole("checkbox", { name: /I reviewed/ }),
  ).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  await copy();
  expect(f.artifacts[0]?.definition.name).toBe("New harmless unreviewed name");
  expect(f.artifacts[0]?.profile.displayName).toBe(
    "New harmless unreviewed name",
  );
});
it("positive control: changing prompt retires prior approval", async () => {
  const f = fixture();
  await openAndReview();
  f.change({ systemPrompt: "New harmless prompt" });
  expect(
    screen.getByRole("checkbox", { name: /I reviewed/ }),
  ).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  expect(f.upload).not.toHaveBeenCalled();
});
it("foreign setups share configuration only and Export uses the connected destination", async () => {
  const f = fixture("wss://source.example", "https://connected.example");
  await openAndReview();
  expect(
    screen.queryByRole("combobox", { name: "What to include" }),
  ).not.toBeInTheDocument();
  await copy();
  expect(f.memoryOpen).not.toHaveBeenCalled();
  expect(f.artifacts[0]?.memory.level).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Export agent" }));
  expect(screen.getByRole("combobox", { name: "Memories" })).toBeDisabled();
});
it("name change retires a cached encoding", async () => {
  const f = fixture();
  await openAndReview();
  await copy();
  f.change({ name: "Renamed" });
  expect(
    screen.getByRole("checkbox", { name: /I reviewed/ }),
  ).not.toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  await copy();
  expect(f.artifacts.map((a) => a.definition.name)).toEqual([
    "Fixture agent",
    "Renamed",
  ]);
});
it("name change cancels in-flight memory encoding before upload", async () => {
  const f = fixture();
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const dispose = vi.fn();
  f.memoryOpen.mockReturnValue({
    refresh: () => pending,
    snapshot: () => ({
      status: "ready",
      listing: { partial: false, entries: [] },
    }),
    dispose,
  });
  await openAndReview();
  const user = userEvent.setup();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "What to include" }), {
    key: "ArrowDown",
  });
  await user.click(
    await screen.findByRole("option", { name: "Agent + core memory" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Copy link",
    }),
  );
  await waitFor(() => expect(f.memoryOpen).toHaveBeenCalledOnce());
  f.change({ name: "Renamed while preparing" });
  await act(async () => {
    resolve();
    await pending;
  });
  expect(dispose).toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  expect(
    screen.getByRole("checkbox", { name: /I reviewed/ }),
  ).not.toBeChecked();
});
it("incomplete memory refuses upload", async () => {
  const f = fixture();
  f.memoryOpen.mockReturnValue({
    refresh: async () => {},
    snapshot: () => ({
      status: "ready",
      listing: { partial: true, entries: [] },
    }),
    dispose: vi.fn(),
  });
  await openAndReview();
  const user = userEvent.setup();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "What to include" }), {
    key: "ArrowDown",
  });
  await user.click(
    await screen.findByRole("option", { name: "Agent + core memory" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Copy link",
    }),
  );
  await waitFor(() => expect(f.memoryOpen).toHaveBeenCalledOnce());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t copy link. Try again.",
  );
  expect(f.upload).not.toHaveBeenCalled();
});

// Team checks cover the sharing adapter with synthetic native responses, not Rust enforcement.
import { TeamDirectShare } from "./DirectShare";
import { decodeTeamFile } from "../../features/agents/team-encoding";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import type { ChannelKit } from "../../features/channel-templates/capability";
function teamFixture() {
  const base = fixture();
  base.mounted.unmount();
  vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(async function (
    this: Blob,
  ) {
    return (await bytes(this)).buffer as ArrayBuffer;
  });
  const portable: TeamSnapshot = {
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: "Harmless team", instructions: "Harmless team instructions" },
    members: [
      {
        format: "buzz-agent-snapshot",
        version: 1,
        definition: {
          name: "Harmless member",
          systemPrompt: "Harmless member instructions",
          runtime: "buzz-agent",
        },
        profile: { displayName: "Harmless member" },
        memory: { level: "none", entries: [] },
      },
    ],
  };
  const exported = vi.fn(
    async (
      _portable: TeamSnapshot,
      _members: string[],
      _community: string,
      level: "none" | "core" | "everything",
    ) => ({
      ...portable,
      members: portable.members.map((member) => ({
        ...member,
        memory: {
          level,
          entries:
            level === "none"
              ? []
              : [{ slug: "core", body: "Harmless team core marker" }],
        },
      })),
    }),
  );
  const control = {
    previewTeam: vi.fn(async () => portable),
    exportTeam: exported,
  } as unknown as AgentControl;
  const kit = {
    loadTeam: vi.fn(async () => portable),
  } as unknown as ChannelKit;
  const artifacts: TeamSnapshot[] = [];
  const empty: unknown[] = [];
  const session = {
    scope: `https://connected.example:${"e".repeat(64)}`,
    viewer: "e".repeat(64),
    outbox: {
      ready: async () => {},
      snapshot: () => empty,
      subscribe: () => () => {},
    },
    directMessages: { delivery: () => "unknown" },
    snapshotUpload: {
      upload: vi.fn(async (file: File) => {
        artifacts.push(JSON.parse(decodeTeamFile(await bytes(file))));
        return {
          url: `https://connected.example/media/${"a".repeat(64)}.png`,
          name: file.name,
          size: file.size,
          sha256: "a".repeat(64),
          type: file.type,
        };
      }),
    },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <TeamDirectShare
        session={session}
        control={control}
        kit={kit}
        team={{
          type: "team",
          id: "harmless-team",
          name: "Harmless team",
          agents: ["ab".repeat(32)],
        }}
        onClose={() => {}}
      />
    </ToastProvider>,
  );
  return { exported, artifacts, portable };
}
it("team adapter defaults to none and actual PNG preserves the native portable payload", async () => {
  const f = teamFixture();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled(),
  );
  await copy();
  expect(f.exported).toHaveBeenCalledExactlyOnceWith(
    f.portable,
    ["ab".repeat(32)],
    "https://connected.example",
    "none",
  );
  expect(f.artifacts).toEqual([f.portable]);
});
it("team adapter calls memory export only after explicit confirmation and encodes its response", async () => {
  const f = teamFixture();
  const user = userEvent.setup();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "What to include" }),
    ).toBeEnabled(),
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "What to include" }), {
    key: "ArrowDown",
  });
  await user.click(
    await screen.findByRole("option", { name: "Team + core memory" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect(f.exported).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Copy link",
    }),
  );
  await screen.findByRole("button", { name: "Copied" });
  expect(f.exported).toHaveBeenCalledExactlyOnceWith(
    f.portable,
    ["ab".repeat(32)],
    "https://connected.example",
    "core",
  );
  expect(f.artifacts[0]?.members[0]?.memory).toEqual({
    level: "core",
    entries: [{ slug: "core", body: "Harmless team core marker" }],
  });
});
