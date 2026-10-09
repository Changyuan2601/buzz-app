// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import { afterEach, expect, it, vi } from "vitest";
import { createCommunityCatalog } from "../../features/agents/catalog";
import {
  catalogRelay,
  memoryStorage,
} from "../../features/agents/catalog-testing";
import { createOutbox } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed, type Key } from "../../features/relay/testing";
import * as communityApi from "../../features/communities/api";
import {
  type AgentEdit,
  createAgentControl,
} from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { importTeamSnapshot } from "../../features/agents/team-import";
import { AgentControlPanel } from "./AgentControlPanel";
import { AgentDirectShare } from "./DirectShare";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
vi.mock("../../features/direct-messages/RecipientPicker", () => ({
  RecipientPicker: () => null,
}));
vi.mock("../../features/agents/team-import", () => ({
  importTeamSnapshot: vi.fn(),
}));
import {
  adoptCatalogTeam,
  CatalogLauncher,
  CatalogShareSwitch,
  CommunityCatalogDialog,
  TeamCatalogPreview,
} from "./CommunityCatalog";

const alice = keypair(),
  bob = keypair();
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});

function client(
  server: ReturnType<typeof catalogRelay>,
  as: Key,
  scope = "wss://catalog.test",
) {
  const writes = createOutbox(as.pubkey, server.writer(as), memoryStorage(), {
    timeoutMs: 1_000,
  });
  const catalog = createCommunityCatalog({
    reader: server.reader(as),
    viewer: as.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  const teams: string[] = [];
  const session = {
    communityCatalog: catalog.queries,
    channelKit: {
      available: true,
      snapshot: () => ({
        entries: teams.map((id) => ({
          record: { value: { type: "team", id } },
        })),
      }),
    },
    scope,
    viewer: as.pubkey,
    names: undefined,
    media: undefined,
  } as unknown as RelaySession;
  return { catalog: catalog.queries, session, teams };
}

const agentBody = JSON.stringify({
  display_name: "Helper",
  system_prompt:
    "Read [this](javascript:alert(1)) <img src=x onerror=alert(1)>",
});
const teamBody = JSON.stringify({
  v: 1,
  name: "Crew",
  members: [{ member_key: "k1", display_name: "Mate", system_prompt: "Help." }],
});
const shareSwitch = () =>
  screen.getByRole("switch", { name: /Share to catalog/ });
const checked = () => shareSwitch().getAttribute("aria-checked") === "true";
const enabled = () =>
  shareSwitch().getAttribute("aria-disabled") !== "true" &&
  !shareSwitch().hasAttribute("data-disabled");

function renderSwitch(catalog: RelaySession["communityCatalog"]) {
  return render(
    <CatalogShareSwitch
      catalog={catalog}
      kind={30175}
      d="helper"
      name="Helper"
      description="Shared."
      content={() => agentBody}
    />,
  );
}

it("shows queued then accepted sharing, and unsharing hides it from another user", async () => {
  const server = catalogRelay();
  const owner = client(server, alice);
  renderSwitch(owner.catalog);
  await waitFor(() => expect(enabled()).toBe(true));
  const release = server.hold();
  fireEvent.click(shareSwitch());
  await screen.findByText(
    "Sharing Helper is queued. It will appear after the relay accepts the update.",
  );
  expect(checked()).toBe(true);
  release();
  await screen.findByText("Published Helper to the community catalog.");

  const viewer = client(server, bob);
  await viewer.catalog.refresh();
  expect(viewer.catalog.snapshot().agents.map((a) => a.d)).toEqual(["helper"]);

  await waitFor(() => expect(enabled()).toBe(true));
  fireEvent.click(shareSwitch());
  await screen.findByText(
    "Helper is no longer discoverable in the community catalog.",
  );
  expect(checked()).toBe(false);
  await viewer.catalog.refresh();
  expect(viewer.catalog.snapshot().agents).toEqual([]);
});

it("shows a relay rejection with a retry that succeeds", async () => {
  const server = catalogRelay();
  const owner = client(server, alice);
  renderSwitch(owner.catalog);
  await waitFor(() => expect(enabled()).toBe(true));
  server.refuse(true);
  fireEvent.click(shareSwitch());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("blocked: not today");
  expect(checked()).toBe(false);
  server.refuse(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Published Helper to the community catalog.");
  expect(checked()).toBe(true);
});

it("retries a failed confirmation read without publishing again", async () => {
  const server = catalogRelay();
  const writes = createOutbox(
    alice.pubkey,
    server.writer(alice),
    memoryStorage(),
    { timeoutMs: 1_000 },
  );
  const base = server.reader(alice);
  let down = false;
  const catalog = createCommunityCatalog({
    reader: {
      read: (...args: Parameters<typeof base.read>) =>
        down ? Promise.reject(new Error("offline")) : base.read(...args),
    },
    viewer: alice.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  renderSwitch(catalog.queries);
  await waitFor(() => expect(enabled()).toBe(true));
  const release = server.hold();
  fireEvent.click(shareSwitch());
  await screen.findByText(/Sharing Helper is queued/);
  // The relay accepts the share, but the confirming head read fails.
  down = true;
  release();
  await screen.findByText(
    /The relay accepted the update, but the catalog could not confirm it\./,
  );
  expect(checked()).toBe(true);
  down = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Published Helper to the community catalog.");
  expect(
    writes.local.snapshot().filter((item) => item.event.kind === 30175),
  ).toHaveLength(1);
});

/** A switch whose strong head reads can fail or wait on the test. */
function confirmingSwitch(extra?: React.ReactNode) {
  const server = catalogRelay();
  const writes = createOutbox(
    alice.pubkey,
    server.writer(alice),
    memoryStorage(),
    { timeoutMs: 1_000 },
  );
  const base = server.reader(alice);
  let failing = false;
  let next: Promise<void> | undefined;
  const catalog = createCommunityCatalog({
    reader: {
      async read(...args: Parameters<typeof base.read>) {
        if (args[0][0]?.consistency === "strong") {
          const wait = next;
          next = undefined;
          await wait;
          if (failing) throw new Error("offline");
        }
        return base.read(...args);
      },
    },
    viewer: alice.pubkey,
    outbox: writes.outbox,
    local: writes.local,
  });
  owners.push(catalog, { dispose: () => writes.dispose() });
  render(
    <>
      <CatalogShareSwitch
        catalog={catalog.queries}
        kind={30175}
        d="helper"
        name="Helper"
        description="Shared."
        content={() => agentBody}
      />
      {extra}
    </>,
  );
  return {
    server,
    fail(value: boolean) {
      failing = value;
    },
    /** Holds the next strong read until the returned release is called. */
    defer() {
      let release = () => {};
      next = new Promise((resolve) => (release = resolve));
      return () => release();
    },
  };
}
const unconfirmed =
  /The relay accepted the update, but the catalog could not confirm it\./;
async function stalledShare(control: ReturnType<typeof confirmingSwitch>) {
  await waitFor(() => expect(enabled()).toBe(true));
  const release = control.server.hold();
  fireEvent.click(shareSwitch());
  await screen.findByText(/Sharing Helper is queued/);
  control.fail(true);
  release();
  await screen.findByText(unconfirmed);
  return screen.getByRole("button", { name: "Retry" });
}

it("keeps confirmation Retry focused while checking and hands focus to the switch", async () => {
  const control = confirmingSwitch();
  const retry = await stalledShare(control);
  retry.focus();
  // Pending: the same control stays mounted, busy and focused.
  let release = control.defer();
  fireEvent.click(retry);
  await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  expect(retry.isConnected).toBe(true);
  expect(document.activeElement).toBe(retry);
  // Repeated failure: still the same focused control, ready again.
  release();
  await screen.findByText(unconfirmed);
  expect(screen.getByRole("button", { name: "Retry" })).toBe(retry);
  expect(retry.getAttribute("aria-busy")).not.toBe("true");
  expect(document.activeElement).toBe(retry);
  // Success: the control goes away and focus lands on the switch.
  control.fail(false);
  release = control.defer();
  fireEvent.click(retry);
  await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  release();
  await screen.findByText("Published Helper to the community catalog.");
  expect(retry.isConnected).toBe(false);
  expect(document.activeElement).toBe(shareSwitch());
});

it("leaves focus where the user moved it when confirmation succeeds", async () => {
  const control = confirmingSwitch(<button type="button">Elsewhere</button>);
  const retry = await stalledShare(control);
  retry.focus();
  control.fail(false);
  const release = control.defer();
  fireEvent.click(retry);
  await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("true"));
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  release();
  await screen.findByText("Published Helper to the community catalog.");
  expect(document.activeElement).toBe(elsewhere);
});

it("hands focus to the switch when a focused Retry leaves with its Dismiss", async () => {
  const server = catalogRelay();
  const owner = client(server, alice);
  renderSwitch(owner.catalog);
  await waitFor(() => expect(enabled()).toBe(true));
  server.refuse(true);
  fireEvent.click(shareSwitch());
  await screen.findByRole("alert");
  const retry = screen.getByRole("button", { name: "Retry" });
  const dismiss = screen.getByRole("button", { name: "Dismiss" });
  retry.focus();
  server.refuse(false);
  const release = server.hold();
  // Resending removes both rejected-notice controls in one commit.
  fireEvent.click(retry);
  await screen.findByText(/Sharing Helper is queued/);
  expect(retry.isConnected).toBe(false);
  expect(dismiss.isConnected).toBe(false);
  expect(document.activeElement).toBe(shareSwitch());
  release();
  await screen.findByText("Published Helper to the community catalog.");
});

it("hands focus to the switch when a newer head supersedes the retried change", async () => {
  const control = confirmingSwitch();
  const retry = await stalledShare(control);
  const dismiss = screen.getByRole("button", { name: "Dismiss" });
  retry.focus();
  // Another device publishes a newer head; confirmation keeps it, which
  // retires this change and both of its controls together.
  control.server.put(
    signed(alice, {
      kind: 30175,
      tags: [["d", "helper"]],
      content: agentBody,
      created_at: Math.floor(Date.now() / 1000) + 60,
    }),
  );
  control.fail(false);
  fireEvent.click(retry);
  await waitFor(() => expect(retry.isConnected).toBe(false));
  expect(dismiss.isConnected).toBe(false);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(checked()).toBe(false);
  expect(document.activeElement).toBe(shareSwitch());
});

it("previews shared entries as plain text and adds an explicit copy", async () => {
  const server = catalogRelay();
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [
        ["d", "helper"],
        ["shared", "true"],
      ],
      content: agentBody,
      created_at: 1,
    }),
  );
  server.put(
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: teamBody,
      created_at: 1,
    }),
  );
  const viewer = client(server, bob);
  const onAddAgent = vi.fn();
  const onAddTeam = vi.fn(async () => "team-copy");
  const { container } = render(
    <CommunityCatalogDialog
      session={viewer.session}
      onClose={() => {}}
      hasCopy={() => true}
      onAddAgent={onAddAgent}
      onAddTeam={onAddTeam}
    />,
  );
  await screen.findByText("Agent instructions");
  expect(screen.getByText("Community member")).toBeTruthy();
  expect(container.ownerDocument.querySelector("img[src=x]")).toBeNull();
  expect(
    container.ownerDocument.querySelector('a[href^="javascript"]'),
  ).toBeNull();
  expect(
    screen.getByText(/Read \[this\]\(javascript:alert\(1\)\)/).tagName,
  ).toBe("PRE");
  fireEvent.click(
    screen.getByRole("button", { name: "Add Helper from Community Catalog" }),
  );
  expect(onAddAgent).toHaveBeenCalledWith(
    expect.objectContaining({ d: "helper", owner: alice.pubkey }),
  );

  fireEvent.click(screen.getByRole("button", { name: /Crew/ }));
  await screen.findByText("1 member");
  fireEvent.click(
    screen.getByRole("button", { name: "Add Crew from Community Catalog" }),
  );
  await screen.findByRole("button", { name: "Crew is already in your teams" });
  expect(onAddTeam).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Crew is already in your teams" })
      .textContent,
  ).toContain("Added to my teams");
});

it("keeps pending team import recovery visible when an agent is selected", async () => {
  const server = catalogRelay();
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [
        ["d", "helper"],
        ["shared", "true"],
      ],
      content: agentBody,
      created_at: 1,
    }),
  );
  server.put(
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: teamBody,
      created_at: 1,
    }),
  );
  const viewer = client(server, bob);
  let rejectImport!: (reason: Error) => void;
  const onAddTeam = vi.fn(
    () =>
      new Promise<string>((_resolve, reject) => {
        rejectImport = reject;
      }),
  );
  const onAddAgent = vi.fn();
  render(
    <CommunityCatalogDialog
      session={viewer.session}
      onClose={() => {}}
      hasCopy={() => false}
      onAddAgent={onAddAgent}
      onAddTeam={onAddTeam}
    />,
  );
  await screen.findByText("Agent instructions");
  fireEvent.click(screen.getByRole("button", { name: /Crew/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Add Crew from Community Catalog" }),
  );
  expect(onAddTeam).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /Helper/ }));
  const addAgent = screen.getByRole("button", {
    name: "Add Helper from Community Catalog",
  });
  expect(addAgent).toBeDisabled();
  fireEvent.click(addAgent);
  expect(onAddAgent).not.toHaveBeenCalled();
  rejectImport(new Error("Some members were not added; retry the team import"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Some members were not added",
  );
  expect(
    screen.getByRole("dialog", { name: "Community Catalog" }),
  ).toBeVisible();
  expect(addAgent).toBeEnabled();
});

it("refuses to add entries that name a transport this app can't run", async () => {
  const server = catalogRelay();
  const alias = { acp_command: "buzz-janet-acp" };
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [
        ["d", "janet"],
        ["shared", "true"],
      ],
      content: JSON.stringify({
        display_name: "Janet",
        system_prompt: "Help.",
        ...alias,
      }),
      created_at: 1,
    }),
  );
  server.put(
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: JSON.stringify({
        v: 1,
        name: "Crew",
        members: [
          {
            member_key: "k1",
            display_name: "Mate",
            system_prompt: "Help.",
            ...alias,
          },
        ],
      }),
      created_at: 1,
    }),
  );
  const viewer = client(server, bob);
  const onAddAgent = vi.fn();
  const onAddTeam = vi.fn(async () => "team-copy");
  render(
    <CommunityCatalogDialog
      session={viewer.session}
      onClose={() => {}}
      hasCopy={() => false}
      onAddAgent={onAddAgent}
      onAddTeam={onAddTeam}
    />,
  );
  await screen.findByText(
    "Janet uses the buzz-janet-acp transport, which this app can't run yet, so it can't be added.",
  );
  const addAgent = screen.getByRole("button", {
    name: "Add Janet from Community Catalog",
  });
  expect(addAgent).toBeDisabled();
  fireEvent.click(addAgent);
  expect(onAddAgent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Crew/ }));
  await screen.findByText(
    "Crew uses the buzz-janet-acp transport, which this app can't run yet, so it can't be added.",
  );
  expect(
    screen.getByRole("button", { name: "Add Crew from Community Catalog" }),
  ).toBeDisabled();
  expect(onAddTeam).not.toHaveBeenCalled();

  // The adapter refuses too, before anything reaches the shared importer.
  const [listed] = viewer.catalog.snapshot().teams;
  if (!listed) throw new Error("team not listed");
  await expect(
    adoptCatalogTeam(
      viewer.session,
      {} as never,
      "https://relay.example.test",
      bob.pubkey,
      listed,
    ),
  ).rejects.toThrow("Crew uses the buzz-janet-acp transport");
  expect(importTeamSnapshot).not.toHaveBeenCalled();
});

it("shows the empty catalog copy", async () => {
  const viewer = client(catalogRelay(), bob);
  render(
    <CommunityCatalogDialog
      session={viewer.session}
      onClose={() => {}}
      hasCopy={() => true}
    />,
  );
  await screen.findByText("Nothing shared yet");
  expect(
    screen.getByText("Shared agents and teams will appear here."),
  ).toBeTruthy();
});

it("adopts a shared agent through the create form with its portable settings", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const server = catalogRelay();
  server.put(
    signed(alice, {
      kind: 30175,
      tags: [
        ["d", "helper"],
        ["shared", "true"],
      ],
      content: JSON.stringify({
        display_name: "Helper",
        system_prompt: "Help.",
        acp_command: "buzz-acp",
        runtime: "goose",
        model: "gpt-x",
        provider: "openai",
        respond_to: "anyone",
        session_policy: "thread",
      }),
      created_at: 1,
    }),
  );
  const fixture = controlFixture();
  fixture.data.createAvailable = true;
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fixture.data.harnessOptions?.push({
    command: "/fixture/goose",
    label: "Goose",
    available: true,
    defaultArgs: ["acp"],
    providers: [],
  });
  fixture.host.prepareCreate = async () => ({
    id: "copy-1",
    pubkey: "cd".repeat(32),
  });
  const commit = vi.fn(async (_request: string, edit: AgentEdit) => {
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: "copy-1",
      pubkey: "cd".repeat(32),
      name: edit.name,
      status: "stopped",
    });
    return structuredClone(fixture.data);
  });
  fixture.host.commitCreate = commit;
  const control = createAgentControl(fixture.host);
  owners.push({ dispose: () => control.dispose() });
  const render_ = (viewer: ReturnType<typeof client>) => (
    <AgentControlPanel
      control={control}
      importDestination="https://relay.example.test"
      createOwner={viewer.session.viewer}
      session={viewer.session}
      catalog={(add, has, open, onClose) => (
        <CatalogLauncher
          session={viewer.session}
          addAgent={add}
          hasAgent={has}
          open={open}
          onClose={onClose}
        />
      )}
    />
  );
  const bobView = client(server, bob);
  const view = render(render_(bobView));
  const openCatalog = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
    return screen.findByRole("button", { name: "Helper" });
  };
  fireEvent.click(await openCatalog());
  const form = await screen.findByRole("dialog", { name: "Add agent" });
  fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
  await waitFor(() => expect(commit).toHaveBeenCalledOnce());
  const edit = commit.mock.calls[0]?.[1];
  expect(edit).toMatchObject({
    name: "Helper",
    systemPrompt: "Help.",
    sessionPolicy: "thread",
    workspace: "/fixture/workspace",
    harness: {
      command: "/fixture/goose",
      args: ["acp"],
      model: "gpt-x",
      provider: "openai",
    },
    environment: { BUZZ_ACP_AGENTS: "10" },
  });
  expect(JSON.stringify(edit)).not.toMatch(/buzz-acp|anyone|respond/);
  await waitFor(() => {
    const close = within(form).queryByRole("button", { name: "Close" });
    if (close) fireEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Create agent" })).toBeNull();
  });

  const added = await openCatalog();
  fireEvent.click(added);
  expect(
    within(screen.getByRole("dialog", { name: "Add agent" })).getByRole(
      "button",
      { name: "Added to My Agents" },
    ),
  ).toBeDisabled();
  fireEvent.keyDown(added, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add agent" })).toBeNull(),
  );

  // Another viewer on this installation has added nothing.
  view.rerender(render_(client(server, keypair())));
  expect(await openCatalog()).toHaveAccessibleName("Helper");
  fireEvent.click(screen.getByRole("button", { name: "Helper" }));
  expect(
    within(screen.getByRole("dialog", { name: "Add agent" })).getByRole(
      "button",
      { name: "Add agent" },
    ),
  ).toBeEnabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  // Deleting the copy makes the entry addable again.
  view.rerender(render_(bobView));
  fixture.data.agents = fixture.data.agents.filter(
    (agent) => agent.id !== "copy-1",
  );
  await control.refresh();
  expect(await openCatalog()).toHaveAccessibleName("Helper");
  fireEvent.click(screen.getByRole("button", { name: "Helper" }));
  expect(
    within(screen.getByRole("dialog", { name: "Add agent" })).getByRole(
      "button",
      { name: "Add agent" },
    ),
  ).toBeEnabled();
});

it.each([
  ["claude", "/fixture/claude-agent-acp", "Claude Code"],
  ["hermes", "/fixture/hermes-acp", "Hermes Agent"],
])(
  "adopts a shared %s agent with the local preset harness",
  async (runtime, command, label) => {
    vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
    const server = catalogRelay();
    server.put(
      signed(alice, {
        kind: 30175,
        tags: [
          ["d", "preset"],
          ["shared", "true"],
        ],
        content: JSON.stringify({
          display_name: "Preset",
          system_prompt: "Help.",
          runtime,
          model: "their-model",
          provider: "their-provider",
          session_policy: "thread",
          avatar_url: "https://media.example.test/preset.png",
        }),
        created_at: 1,
      }),
    );
    const fixture = controlFixture();
    fixture.data.createAvailable = true;
    fixture.data.defaultWorkspace = "/fixture/workspace";
    fixture.data.harnessOptions?.push({
      command,
      label,
      available: true,
      defaultArgs: [],
      providers: [],
    });
    fixture.host.prepareCreate = async () => ({
      id: "copy-1",
      pubkey: "cd".repeat(32),
    });
    const commit = vi.fn(async (_request: string, edit: AgentEdit) => {
      fixture.data.agents.push({
        ...structuredClone(fixture.agent),
        id: "copy-1",
        pubkey: "cd".repeat(32),
        name: edit.name,
        status: "stopped",
      });
      return structuredClone(fixture.data);
    });
    fixture.host.commitCreate = commit;
    const control = createAgentControl(fixture.host);
    owners.push({ dispose: () => control.dispose() });
    const viewer = client(server, bob);
    render(
      <AgentControlPanel
        control={control}
        importDestination="https://relay.example.test"
        createOwner={viewer.session.viewer}
        session={viewer.session}
        catalog={(add, has, open, onClose) => (
          <CatalogLauncher
            session={viewer.session}
            addAgent={add}
            hasAgent={has}
            open={open}
            onClose={onClose}
          />
        )}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preset" }));
    const form = await screen.findByRole("dialog", { name: "Add agent" });
    fireEvent.click(within(form).getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    // The preset owns its model and credentials; the default harness differs.
    expect(commit.mock.calls[0]?.[1]).toMatchObject({
      sessionPolicy: "thread",
      picture: "https://media.example.test/preset.png",
      harness: { command, args: [], model: "", provider: "" },
    });
  },
);

it("adds a catalog team through the shared importer only while its listed head is current", async () => {
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const server = catalogRelay();
  const crew = (created_at: number, name = "Crew", shared = true) =>
    signed(alice, {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ...(shared ? [["shared", "true"]] : []),
      ] as string[][],
      content: JSON.stringify({
        v: 1,
        name,
        members: [
          {
            member_key: "k1",
            display_name: "Mate",
            system_prompt: "Help.",
            runtime: "goose",
            session_policy: "thread",
          },
        ],
      }),
      created_at,
    });
  server.put(crew(1));
  const viewer = client(server, bob);
  const imported = vi.mocked(importTeamSnapshot);
  imported.mockImplementation(async () => {
    viewer.teams.push("team-copy");
    return { id: "team-copy", agents: [], memories: [] };
  });
  const control = { previewTeam: vi.fn() } as unknown as Parameters<
    typeof CatalogLauncher
  >[0]["control"];
  const view = () =>
    render(
      <CatalogLauncher
        session={viewer.session}
        addAgent={undefined}
        hasAgent={() => false}
        open
        onClose={() => {}}
        control={control}
        destination="https://catalog.test"
      />,
    );
  const openTeam = async () => {
    // The only entry is selected by default.
    return screen.findByRole("button", {
      name: /Crew (is already in your teams|from Community Catalog)/,
    });
  };
  view();
  fireEvent.click(await openTeam());
  await screen.findByRole("button", { name: "Crew is already in your teams" });
  expect(imported).toHaveBeenCalledOnce();
  const call = imported.mock.calls[0];
  if (!call) throw new Error("team was not imported");
  const [usedControl, kit, snapshot, options] = call;
  expect(usedControl).toBe(control);
  expect(kit).toBe(viewer.session.channelKit);
  expect(options).toEqual({
    destination: "https://catalog.test",
    owner: bob.pubkey,
    keepAllowlist: false,
    restoreMemory: false,
  });
  expect(snapshot).toMatchObject({
    team: { name: "Crew" },
    members: [
      {
        definition: {
          name: "Mate",
          runtime: "goose",
          sessionPolicy: "thread",
        },
        memory: { level: "none", entries: [] },
      },
    ],
  });
  cleanup();

  // Deleting the local copy makes it addable again; a head that moved after
  // listing is refused without importing.
  viewer.teams.length = 0;
  view();
  const add = await openTeam();
  expect(add).toHaveAccessibleName("Add Crew from Community Catalog");
  server.put(crew(2, "Crew v2"));
  fireEvent.click(add);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "This team has changed since it was listed. Refresh and try again.",
  );
  expect(imported).toHaveBeenCalledOnce();
  cleanup();

  // Once unshared, other users neither find it nor can add the old listing.
  server.put(crew(3, "Crew v2", false));
  await viewer.catalog.refresh();
  expect(viewer.catalog.snapshot().teams).toEqual([]);
});

it.each(["channel", "thread"] as const)(
  "shares an inheriting agent through the real direct-share catalog switch with %s defaults",
  async (sessionPolicy) => {
    const server = catalogRelay();
    const owner = client(server, alice, `https://catalog.test:${alice.pubkey}`);
    const fixture = controlFixture();
    fixture.agent.relayUrl = "wss://catalog.test";
    fixture.agent.harness.command = "buzz-agent";
    fixture.data.defaultSettings = {
      harness: "buzz-agent",
      provider: "",
      model: "",
      effort: "",
      sessionPolicy,
      environmentKeys: [],
    };
    const control = createAgentControl(fixture.host);
    owners.push(control);
    await control.refresh();
    const operations: never[] = [];
    const session = {
      ...owner.session,
      outbox: {
        ready: async () => {},
        snapshot: () => operations,
        subscribe: () => () => {},
      },
      directMessages: { delivery: () => "unknown" },
    } as unknown as RelaySession;
    render(
      <ToastProvider>
        <AgentDirectShare
          session={session}
          agent={fixture.agent}
          control={control}
          name={fixture.agent.name}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(enabled()).toBe(true));
    fireEvent.click(shareSwitch());
    await screen.findByText(
      `Published ${fixture.agent.name} to the community catalog.`,
    );
    const viewer = client(server, bob);
    await viewer.catalog.refresh();
    expect(viewer.catalog.snapshot().agents).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({
          displayName: fixture.agent.name,
          sessionPolicy,
        }),
      }),
    ]);
  },
);

it("routes team member artwork through authenticated session media, never a raw remote URL", () => {
  const remote = "https://avatar.example.test/member.png";
  const media = vi.fn((url: string) => {
    expect(url).toBe(remote);
    return "/authenticated/media/avatar";
  });
  const session = { media } as unknown as RelaySession;
  const publication = {
    kind: 30178 as const,
    eventId: "team-head",
    owner: alice.pubkey,
    d: "crew",
    createdAt: 1,
    name: "Crew",
    members: [
      {
        memberKey: "one",
        displayName: "Mate",
        systemPrompt: "Help.",
        sessionPolicy: "thread" as const,
        avatarUrl: remote,
      },
    ],
  };
  const view = render(
    <TeamCatalogPreview publication={publication} session={session} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Mate/ }));
  expect(media).toHaveBeenCalledWith(remote, "small");
  expect(
    view.container.querySelector('img[src="/authenticated/media/avatar"]'),
  ).toBeTruthy();
  expect(view.container.querySelector(`img[src="${remote}"]`)).toBeNull();
});
