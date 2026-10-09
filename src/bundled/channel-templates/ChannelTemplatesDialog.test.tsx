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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentControl } from "../../features/agents/control";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type {
  KitEntry,
  Team,
  Template,
} from "../../features/channel-templates/model";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";
import { TemplateLibrary } from "./TemplateLibrary";

beforeEach(() => {
  // jsdom does not read focus options; Base UI detects this browser capability.
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    void options?.preventScroll;
    focus.call(this, options);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const team: Team = { type: "team", id: "team", name: "Saved team", agents: [] };
const entry: KitEntry = {
  eventId: "head",
  createdAt: 1,
  record: {
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: team,
  },
};
function fixture(
  editor = false,
  entries: KitEntry[] = [entry],
  status: "ready" | "loading" = "ready",
  agentsReady = true,
  section: "template" | "team" = "template",
) {
  const state = { status, entries };
  const save = vi.fn<ChannelKit["save"]>();
  const kit: ChannelKit = {
    available: true,
    loadTeam: vi.fn(async () => {
      throw new Error("No portable fixture team");
    }),
    savePortable: vi.fn(async () => {
      throw new Error("No portable fixture save");
    }),
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
  };
  const close = vi.fn();
  const tree = () =>
    editor ? (
      <ChannelTemplatesDialog
        open
        onOpenChange={close}
        kit={kit}
        agents={[]}
        initial={team}
        expected="head"
        active={() => true}
      />
    ) : (
      <TemplateLibrary
        section={section}
        kit={kit}
        active={() => true}
        catalog={{
          kit: state,
          agents: [
            {
              pubkey: "a".repeat(64),
              name: "Carl",
              managed: false,
              avatar: undefined,
            },
          ],
          agentsReady,
          agentsComplete: true,
          agentsPending: false,
          error: undefined,
          refresh: vi.fn(),
        }}
      />
    );
  const view = render(tree(), { wrapper: ToastProvider });
  return {
    save,
    close,
    setEntries(next: KitEntry[]) {
      state.entries = next;
      view.rerender(tree());
    },
  };
}
it("shows the library on the page and returns from editing without a library dialog", async () => {
  const user = userEvent.setup();
  fixture(false, [entry], "ready", true, "team");
  expect(
    screen.getByRole("article", { name: "Saved team" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const trigger = screen.getByRole("button", {
    name: "Actions for Saved team",
  });
  expect(
    screen.getByRole("button", { name: "Edit team Saved team" }),
  ).toBeVisible();
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Edit team" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Saved team",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(trigger).toHaveFocus());
});
it("shows preview rejection beside import and clears it on retry", async () => {
  const previewTeam = vi.fn(async (_content: string): Promise<TeamSnapshot> => {
    throw new Error("Invalid team snapshot");
  });
  const state = { status: "ready" as const, entries: [entry] };
  const kit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save: vi.fn(),
  } as unknown as ChannelKit;
  const { container } = render(
    <TemplateLibrary
      section="team"
      kit={kit}
      active={() => true}
      catalog={{
        kit: state,
        agents: [],
        agentsReady: true,
        agentsComplete: true,
        agentsPending: false,
        error: undefined,
        refresh: vi.fn(),
      }}
      control={{ previewTeam, create: vi.fn() } as unknown as AgentControl}
      session={
        {
          viewer: "ab".repeat(32),
          scope: `https://relay.example.test:${"ab".repeat(32)}`,
          communityCatalog: { available: () => false },
        } as RelaySession
      }
    />,
    { wrapper: ToastProvider },
  );
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File(['{"broken":true}'], "team.json", {
    type: "application/json",
  });
  fireEvent.click(screen.getByRole("button", { name: "Create team" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.change(input, { target: { files: [file] } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid team snapshot",
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  previewTeam.mockResolvedValueOnce({
    format: "buzz-team-snapshot",
    version: 1,
    team: { name: "Recovered" },
    members: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "Create team" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.change(input, { target: { files: [file] } });
  expect(
    await screen.findByRole("dialog", { name: /Import team snapshot/i }),
  ).toBeInTheDocument();
  expect(previewTeam).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("opens team creation directly without a chooser", async () => {
  const user = userEvent.setup();
  fixture(false, [], "ready", true, "team");
  await user.click(screen.getByRole("button", { name: "Create team" }));
  const dialog = screen.getByRole("dialog", { name: "Add team" });
  expect(
    within(dialog).getByRole("button", { name: "Save team" }),
  ).toBeDisabled();
  expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeVisible();
});

it("delete cancellation leaves the page and saved data intact", async () => {
  const user = userEvent.setup();
  const { save } = fixture(false, [entry], "ready", true, "team");
  const trigger = screen.getByRole("button", {
    name: "Actions for Saved team",
  });
  for (const dismissal of ["backdrop", "escape", "close", "cancel"]) {
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete team…" }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "Delete “Saved team”?",
    });
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    expect(confirmation).toHaveAccessibleDescription(
      /Its agents and their channel memberships stay unchanged/,
    );
    await user.click(confirmation);
    expect(confirmation).toBeInTheDocument();
    if (dismissal === "backdrop")
      await user.click(
        document.querySelector(".buzz-dialog-backdrop") as Element,
      );
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        within(confirmation).getByRole("button", {
          name: dismissal === "close" ? "Close" : "Cancel",
        }),
      );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(
      screen.getByRole("article", { name: "Saved team" }),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(trigger, `dismissal: ${dismissal}`).toHaveFocus(),
    );
  }
});
it("deletion preserves its revision, locks dismissal while pending and retains errors for retry", async () => {
  const user = userEvent.setup();
  const { save } = fixture(false, [entry], "ready", true, "team");
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, no) => {
    reject = no;
  });
  save.mockReturnValueOnce(pending);
  await user.click(
    screen.getByRole("button", { name: "Actions for Saved team" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete team…" }),
  );
  const confirmation = screen.getByRole("dialog", {
    name: "Delete “Saved team”?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Delete" }),
  );
  try {
    expect(save).toHaveBeenCalledExactlyOnceWith(team, "head", true);
    expect(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(confirmation).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await user.keyboard("{Escape}");
    expect(confirmation).toBeInTheDocument();
  } finally {
    await act(async () => {
      reject(new Error("Delete rejected"));
      await pending.catch(() => {});
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Delete rejected");
  expect(
    within(confirmation).getByRole("button", { name: "Delete" }),
  ).toBeEnabled();
  expect(save).toHaveBeenCalledOnce();
});
it("editing saves against the original revision and closes back to its caller", async () => {
  const user = userEvent.setup();
  const { save, close } = fixture(true);
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(
    screen.getByRole("textbox", { name: "Name" }),
    "Renamed team",
  );
  await user.click(screen.getByRole("button", { name: "Save team" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(
    { ...team, name: "Renamed team" },
    "head",
  );
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
});

const template: Template = {
  type: "template",
  id: "original",
  name: "Saved template",
  description: "Description",
  agents: ["a".repeat(64)],
  teamIds: ["team"],
  canvas: "# Goals",
};
const templateEntry: KitEntry = {
  ...entry,
  eventId: "template-head",
  record: { ...entry.record, value: template },
};
it.each(["Saved template", "x".repeat(120)])(
  "duplicates %s as an unsaved independent draft",
  async (name) => {
    const user = userEvent.setup();
    const source = { ...template, name };
    const { save } = fixture(false, [
      entry,
      { ...templateEntry, record: { ...templateEntry.record, value: source } },
    ]);
    const duplicate = async () => {
      await user.click(
        screen.getByRole("button", { name: `Actions for ${name}` }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Duplicate template" }),
      );
    };
    await duplicate();
    const copyName = `${name.slice(0, 113)} (copy)`;
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(copyName);
    expect(copyName.length).toBeLessThanOrEqual(120);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled();
    await duplicate();
    await user.click(screen.getByRole("button", { name: "Save template" }));
    expect(save).toHaveBeenCalledOnce();
    const call = save.mock.calls[0];
    if (!call) throw new Error("Save not called");
    const [value, expected] = call;
    expect(value).toEqual({
      ...source,
      name: copyName,
      id: expect.any(String),
    });
    expect(value.id).not.toBe(source.id);
    expect(expected).toBeUndefined();
    expect(source.name).toBe(name);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  },
);
it.each(["template", "team"] as const)(
  "creates a new %s with no existing revision",
  async (type) => {
    const user = userEvent.setup();
    const { save } = fixture(false, [entry], "ready", true, type);
    const trigger = screen.getByRole("button", {
      name: type === "team" ? "Create team" : "New template",
    });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: `Save ${type}` })).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      `New saved ${type}`,
    );
    await user.click(screen.getByRole("button", { name: `Save ${type}` }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        type,
        id: expect.any(String),
        name: `New saved ${type}`,
      }),
      undefined,
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  },
);
it.each(["template", "team"] as const)(
  "successful %s deletion removes its row and focuses its New action",
  async (type) => {
    const user = userEvent.setup();
    const item = type === "team" ? entry : templateEntry;
    const { save, setEntries } = fixture(false, [item], "ready", true, type);
    save.mockImplementation(async () => {
      setEntries([]);
      return "deleted-head";
    });
    await user.click(
      screen.getByRole("button", {
        name: `Actions for ${type === "team" ? team.name : template.name}`,
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: `Delete ${type}…` }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("article")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: type === "team" ? "Create team" : "New template",
        }),
      ).toHaveFocus(),
    );
  },
);
it("names avatars without repeating the full public key in their accessible label", () => {
  fixture(false, [templateEntry]);
  expect(
    within(screen.getByRole("article")).getByRole("button", {
      name: "Carl",
    }),
  ).toBeInTheDocument();
});
it("shows empty sections and disables creation while catalog or agents are loading", () => {
  const empty = fixture(false, []);
  expect(screen.getByText("Your next channel starts here")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Create team" }),
  ).not.toBeInTheDocument();
  expect(empty.save).not.toHaveBeenCalled();
  cleanup();
  fixture(false, [], "ready", true, "team");
  expect(screen.getByText("Bring your agents together")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "New template" }),
  ).not.toBeInTheDocument();
  cleanup();
  fixture(false, [], "loading", true, "team");
  expect(screen.getByRole("button", { name: "Create team" })).toBeDisabled();
  cleanup();
  fixture(false, [], "loading");
  expect(screen.getByRole("button", { name: "New template" })).toBeDisabled();

  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading your templates",
  );
  cleanup();
  fixture(false, [], "ready", false);
  expect(screen.getByRole("button", { name: "New template" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading available agents",
  );
});
it("closes the save-as-template editor after successful creation", async () => {
  const save = vi.fn();
  const close = vi.fn();
  const kit: ChannelKit = {
    available: true,
    loadTeam: vi.fn(async () => {
      throw new Error("No portable fixture team");
    }),
    savePortable: vi.fn(async () => {
      throw new Error("No portable fixture save");
    }),
    snapshot: () => state,
    subscribe: () => () => {},
    ensure() {},
    async refresh() {},
    save,
  };
  const state = { status: "ready" as const, entries: [] };
  render(
    <ChannelTemplatesDialog
      open
      kit={kit}
      agents={[]}
      initial={template}
      active={() => true}
      onOpenChange={close}
    />,
    { wrapper: ToastProvider },
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Save template" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(template, undefined);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
});

it("discloses optional setup without losing edits and retains failed saves for retry", async () => {
  const user = userEvent.setup();
  const { save } = fixture();
  const trigger = screen.getByRole("button", { name: "New template" });
  await user.click(trigger);
  expect(
    screen.getByRole("dialog", { name: "New template" }),
  ).toHaveAccessibleDescription(/existing channels stay unchanged/);
  const name = screen.getByRole("textbox", { name: "Name" });
  await waitFor(() => expect(name).toHaveFocus());
  expect(
    screen.queryByRole("textbox", { name: "Starting Canvas (Markdown)" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Saved teams" }),
  ).not.toBeInTheDocument();
  await user.type(name, "Project kickoff");
  await user.click(screen.getByRole("button", { name: "Teams & agents" }));
  await user.click(screen.getByRole("checkbox", { name: "Saved team (0)" }));
  const members = screen.getByRole("button", { name: "Teams & agents (1)" });
  await user.click(members);
  expect(members).toHaveAttribute("aria-expanded", "false");
  await user.click(members);
  expect(
    screen.getByRole("checkbox", { name: "Saved team (0)" }),
  ).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Starting Canvas" }));
  await user.type(
    screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
    "# Plan",
  );
  await user.click(
    screen.getByRole("button", { name: "Starting Canvas · Added" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Starting Canvas · Added" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
  ).toHaveValue("# Plan");
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_, no) => {
    reject = no;
  });
  save.mockReturnValueOnce(pending);
  const submit = screen.getByRole("button", { name: "Save template" });
  await user.click(submit);
  try {
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Project kickoff",
        teamIds: ["team"],
        canvas: "# Plan",
      }),
      undefined,
    );
    expect(submit).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "New template" }),
    ).toBeInTheDocument();
  } finally {
    await act(async () => {
      reject(new Error("Save rejected"));
      await pending.catch(() => {});
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Save rejected");
  expect(name).toHaveValue("Project kickoff");
  save.mockResolvedValueOnce("saved");
  await user.click(submit);
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("opens saved optional sections and keeps missing-member errors visible when collapsed", async () => {
  const user = userEvent.setup();
  const saved = {
    ...templateEntry,
    record: {
      ...templateEntry.record,
      value: { ...template, teamIds: ["missing"] },
    },
  };
  const { save } = fixture(false, [saved]);
  await user.click(
    screen.getByRole("button", { name: "Actions for Saved template" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit template" }),
  );
  expect(screen.getByRole("dialog", { name: "Edit template" })).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
  ).toHaveValue("# Goals");
  expect(
    screen.getByRole("checkbox", { name: "Unavailable team (0)" }),
  ).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Teams & agents (2)" }));
  expect(screen.getByRole("alert")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(save).not.toHaveBeenCalled();
});

it("keeps a team editor free of template-only or empty-search fields", async () => {
  fixture(true);
  const editor = screen.getByRole("dialog", { name: "Edit team" });
  expect(editor).toHaveAccessibleDescription(/Choose agents/);
  expect(
    within(editor).queryByRole("textbox", { name: "Description" }),
  ).not.toBeInTheDocument();
  expect(
    within(editor).queryByRole("textbox", { name: "Find individual agents" }),
  ).not.toBeInTheDocument();
  expect(
    within(editor).getByText(/No agents from the Agents page/),
  ).toBeVisible();
});

it("edits portable metadata without reconstructing or dropping member definitions", async () => {
  const user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const snapshot: TeamSnapshot = {
    format: "buzz-team-snapshot",
    version: 1,
    team: {
      name: "Portable",
      description: "Shared purpose",
      instructions: "TEAM_A",
    },
    members: [
      {
        format: "buzz-agent-snapshot",
        version: 1,
        definition: {
          name: "Member",
          systemPrompt: "INDIVIDUAL_A",
          runtime: "goose",
          model: "model-a",
          provider: "provider-a",
          sessionPolicy: "thread",
          respondTo: "allowlist",
          respondToAllowlist: ["b".repeat(64)],
          parallelism: 3,
          idleTimeoutSeconds: 60,
          maxTurnDurationSeconds: 120,
          namePool: ["Alias"],
        },
        profile: {
          displayName: "Member",
          about: "Profile",
          avatarUrl: "https://example.test/a.png",
        },
        memory: { level: "none", entries: [] },
      },
    ],
  };
  const value: Team = {
    type: "team",
    id: "portable",
    name: "Portable",
    agents: [pubkey],
    portable: {
      version: 1,
      owner: "c".repeat(64),
      revision: crypto.randomUUID(),
      digest: "d".repeat(64),
      bytes: 100,
      chunks: 1,
    },
  };
  const savePortable = vi
    .fn<ChannelKit["savePortable"]>()
    .mockResolvedValue("new-head");
  const save = vi.fn<ChannelKit["save"]>();
  const state = { status: "ready" as const, entries: [] };
  const kit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
    loadTeam: vi.fn(async () => snapshot),
    savePortable,
  } as ChannelKit;
  const captureTeam = vi.fn();
  const control = {
    previewTeam: vi.fn(async () => structuredClone(snapshot)),
    snapshot: () => ({ data: { agents: [] } }),
    captureTeam,
  } as unknown as AgentControl;
  const viewer = "c".repeat(64);
  const session = {
    viewer,
    scope: `https://relay.example.test:${viewer}`,
  } as RelaySession;
  render(
    <ChannelTemplatesDialog
      open
      onOpenChange={vi.fn()}
      kit={kit}
      initial={value}
      expected="old-head"
      active={() => true}
      session={session}
      control={control}
      agents={[{ pubkey, name: "Member", avatar: undefined }]}
    />,
    { wrapper: ToastProvider },
  );
  const instructions = await screen.findByRole("textbox", {
    name: "Team Instructions",
  });
  await waitFor(() => expect(instructions).toHaveValue("TEAM_A"));
  await user.clear(instructions);
  await user.type(instructions, "TEAM_B");
  await user.click(screen.getByRole("button", { name: "Save team" }));
  expect(savePortable).toHaveBeenCalledOnce();
  expect(savePortable.mock.calls[0]?.[1]).toEqual({
    ...snapshot,
    team: { ...snapshot.team, instructions: "TEAM_B" },
  });
  expect(savePortable.mock.calls[0]?.[0].agents).toEqual([pubkey]);
  expect(savePortable.mock.calls[0]?.[2]).toBe("old-head");
  expect(captureTeam).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it.each(
  [
    [],
    ["a".repeat(64)],
    ["a".repeat(64), "b".repeat(64)],
    ["b".repeat(64)],
  ].map((selected) => ({ selected })),
)(
  "routes new-team metadata and save through the same membership eligibility (%j)",
  async ({ selected }) => {
    const user = userEvent.setup();
    const viewer = "c".repeat(64);
    const member = {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: { name: "Local", systemPrompt: "INDIVIDUAL" },
      profile: { displayName: "Local" },
      memory: { level: "none", entries: [] },
    };
    const captureTeam = vi.fn(async () => ({
      format: "buzz-team-snapshot",
      version: 1,
      team: { name: "New" },
      members: [member],
    }));
    const save = vi.fn();
    const savePortable = vi.fn();
    const state = { status: "ready", entries: [] };
    const kit = {
      available: true,
      snapshot: () => state,
      subscribe: () => () => {},
      ensure: vi.fn(),
      save,
      savePortable,
    } as unknown as ChannelKit;
    const control = {
      captureTeam,
      snapshot: () => ({
        data: {
          agents: [
            { pubkey: "a".repeat(64), relayUrl: "wss://relay.example.test" },
          ],
        },
      }),
    } as unknown as AgentControl;
    render(
      <ChannelTemplatesDialog
        open
        onOpenChange={vi.fn()}
        kit={kit}
        active={() => true}
        initial={{ type: "team", id: "new", name: "New", agents: selected }}
        agents={[]}
        session={
          {
            viewer,
            scope: `https://relay.example.test:${viewer}`,
          } as RelaySession
        }
        control={control}
      />,
      { wrapper: ToastProvider },
    );
    const eligible = selected.length === 1 && selected[0] === "a".repeat(64);
    if (eligible) {
      await user.type(
        screen.getByRole("textbox", { name: "Description" }),
        "Purpose",
      );
      await user.type(
        screen.getByRole("textbox", { name: "Team Instructions" }),
        "TEAM",
      );
    } else {
      expect(
        screen.queryByRole("textbox", { name: "Description" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Team Instructions" }),
      ).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Save team" }));
    if (eligible) {
      expect(save).not.toHaveBeenCalled();
      expect(savePortable).toHaveBeenCalledOnce();
      expect(savePortable.mock.calls[0]?.[1].team).toEqual({
        name: "New",
        description: "Purpose",
        instructions: "TEAM",
      });
    } else {
      expect(save).toHaveBeenCalledOnce();
      expect(savePortable).not.toHaveBeenCalled();
      expect(captureTeam).not.toHaveBeenCalled();
    }
  },
);
