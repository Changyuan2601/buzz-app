// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentSections } from "../../features/agents/tabs";
import type { Agents } from "../../features/agents/service";
import type { Agent } from "../../features/agents/service";
import { fakeSpawn } from "./goose-testing";
import { type Config, DEFAULT_CONFIG, type GooseRuntime } from "./runtime";
import { GooseProvider } from "./provider";
import { ProviderDialog } from "../agents/ProviderDialog";
import type { RegisteredAgentType } from "../../features/agents/service";
import { createRef } from "react";
import { memoryStorage } from "../../features/agents/test-fakes";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";

/** New agent's fields read no sessions. */
const unused = {
  runtime: {} as GooseRuntime,
  history: new GooseHistory(undefined),
};

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

beforeEach(() => {
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROVIDERS = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    description: "Claude models",
    defaultModel: "claude-sonnet-5-5",
    visibleInSetup: true,
    configKeys: [{ name: "ANTHROPIC_API_KEY", required: true, secret: true }],
    models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }],
  },
  {
    providerId: "databricks",
    providerName: "Databricks",
    configured: true,
    visibleInSetup: true,
    // As goose lists it: both fields entered, the token optional.
    configKeys: [
      { name: "DATABRICKS_HOST", required: true, secret: false },
      { name: "DATABRICKS_TOKEN", required: false, secret: true },
    ],
  },
];

function created(
  options: Readonly<{
    reply?: string;
    spawn?: (fake: ReturnType<typeof fakeSpawn>) => GooseSetup;
  }> = {},
) {
  const saved = new Map<string, Set<string>>([
    ["databricks", new Set(["DATABRICKS_HOST"])],
  ]);
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    saved,
    reply: options.reply ?? "OK",
  });
  const { Create, CreateModel } = createTabs({
    setup: options.spawn?.(fake) ?? new GooseSetup(fake.spawn),
    ...unused,
  });
  if (!CreateModel) throw new Error("no model field");
  const changes: Config[] = [];
  function Harness() {
    const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
    const onChange = (next: Config) => {
      changes.push(next);
      setConfig(next);
    };
    return (
      <>
        <Create config={config} disabled={false} onChange={onChange} />
        <CreateModel config={config} disabled={false} onChange={onChange} />
      </>
    );
  }
  render(<Harness />);
  return { fake, saved, changes };
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** The model field, labeled with goose's default or the agent's choice. */
const modelButton = () =>
  screen.getByRole("button", { name: /goose default|Anthropic/ });

/** Opens the provider dialog from the model field. */
async function openChoices() {
  await userEvent.setup().click(modelButton());
  return screen.findByRole("dialog", { name: "Provider and model" });
}

it("keeps New agent's card to instructions; the model field shows goose's default", async () => {
  created();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent(
      "goose default (Databricks · goose-claude)",
    ),
  );
});

it("chooses a provider in its dialog, saves its key into goose, and tests it", async () => {
  const { fake, saved, changes } = created();
  const user = userEvent.setup();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("From goose config (Databricks)"),
  );
  // A provider goose has set up offers to change its fields, not empty ones.
  expect(
    within(dialog).getByText("Databricks is set up in goose."),
  ).toBeVisible();

  await choose("Provider", "Anthropic");
  const key = await within(dialog).findByLabelText("API key");
  expect(key).toHaveAttribute("type", "password");
  await user.type(key, "sk-test");
  await user.click(
    within(dialog).getByRole("button", { name: "Save to goose" }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByText("Anthropic is set up in goose."),
    ).toBeVisible(),
  );
  expect(saved.get("anthropic")).toEqual(new Set(["ANTHROPIC_API_KEY"]));

  await choose("Model", "Claude Opus 5.5");
  await user.click(
    within(dialog).getByRole("button", { name: "Test connection" }),
  );
  expect(await within(dialog).findByRole("status")).toHaveTextContent(
    "Connected",
  );
  expect(fake.geese.at(-1)?.env).toMatchObject({
    GOOSE_PROVIDER: "anthropic",
    GOOSE_MODEL: "claude-opus-5-5",
  });
  // Nothing reaches the agent until the choice is used.
  expect(changes).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Use" }));
  expect(changes.at(-1)).toMatchObject({
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(modelButton()).toHaveTextContent("Anthropic · claude-opus-5-5");
});

it("saves a key on Enter in Settings, and only an absolute or ~/ workspace", async () => {
  const saved = new Map<string, Set<string>>();
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    saved,
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake.spawn),
    ...unused,
  });
  const save = vi.fn(async (_config: Config) => undefined);
  render(
    <SettingsTab
      agent={
        {
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={save}
    />,
  );
  const user = userEvent.setup();
  await choose("Provider", "Anthropic");
  await user.type(await screen.findByLabelText("API key"), "sk-test{Enter}");
  expect(
    await screen.findByText("Anthropic is set up in goose."),
  ).toBeVisible();
  expect(saved.get("anthropic")).toEqual(new Set(["ANTHROPIC_API_KEY"]));
  expect(save).not.toHaveBeenCalled();

  const workspace = screen.getByLabelText("Workspace");
  await user.clear(workspace);
  await user.type(workspace, "projects/goose");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter an absolute or ~/… workspace path.",
  );
  expect(save).not.toHaveBeenCalled();
  await user.clear(workspace);
  await user.type(workspace, "~/projects/goose");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        workspace: "~/projects/goose",
      }),
    ),
  );
});

it("reads a provider's models again after its fields are saved", async () => {
  const { fake } = created({
    spawn: (fake) => new GooseSetup(fake.spawn),
  });
  const user = userEvent.setup();
  const dialog = await openChoices();
  const listed = () =>
    fake.geese
      .flatMap((goose) => goose.received)
      .filter(
        (message) =>
          message.method === "_goose/unstable/providers/supported-models/list",
      ).length;
  await waitFor(() => expect(listed()).toBe(1));
  await user.click(within(dialog).getByRole("button", { name: "Change" }));
  await user.type(within(dialog).getByLabelText(/host/i), "https://new.test");
  await user.click(
    within(dialog).getByRole("button", { name: "Save to goose" }),
  );
  await waitFor(() => expect(listed()).toBe(2));
});

it("shows what the provider said when the test fails", async () => {
  created({ reply: "Authentication failed: invalid x-api-key" });
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toBeEnabled(),
  );
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Test connection" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Authentication failed: invalid x-api-key",
  );
});

it("says when the bundled goose-acp is missing, and tries again", async () => {
  let installed = false;
  created({
    spawn: (fake) =>
      new GooseSetup(async (id, options) => {
        if (id === "goose" && !installed)
          throw new Error("No such file or directory (os error 2)");
        return fake.spawn(id, options);
      }),
  });
  const dialog = await openChoices();
  expect(
    await within(dialog).findByText(/goose-acp is missing/),
  ).toBeInTheDocument();
  installed = true;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).queryByText(/goose-acp is missing/),
    ).not.toBeInTheDocument(),
  );
});

it("lists the agent's goose sessions and shows one's transcript", async () => {
  const agent = "c".repeat(64);
  const context = [
    "<context>",
    "Scope: thread",
    "Session scope: thread",
    "Channel: general (#chan)",
    `Thread root: ${"1".repeat(64)}`,
    `Agent: ${agent}`,
    "</context>",
    "",
    '<buzz-event type="@mention">',
    "Content: @Gander what's up?",
    "</buzz-event>",
  ].join("\n");
  const fake = fakeSpawn({
    home: "/home/test",
    history: [
      {
        sessionId: "s1",
        title: "Gander · #general · 11111111",
        cwd: "/home/test/.buzz",
        updatedAt: "2027-01-15T08:00:00Z",
        conversation: [
          {
            role: "user",
            created: 1_800_000_000,
            content: [{ type: "text", text: context }],
            metadata: { userVisible: true },
          },
          {
            role: "assistant",
            created: 1_800_000_001,
            content: [
              {
                type: "toolRequest",
                id: "t1",
                toolCall: {
                  status: "success",
                  value: {
                    name: "buzz__send",
                    arguments: { text: "Hi from goose", final: true },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  // The runtime keeps one snapshot until its sessions change.
  const none: never[] = [];
  const runtime = {
    subscribe: () => () => {},
    sessions: () => none,
  } as unknown as GooseRuntime;
  const { ActivityTab } = createTabs({
    setup: new GooseSetup(fake.spawn),
    runtime,
    history: new GooseHistory(fake.spawn),
  });
  render(
    <ActivityTab
      agent={
        {
          pubkey: agent,
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByText("#general · 11111111")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", {
      name: "View transcript: #general · 11111111",
    }),
  );
  expect(await screen.findByText("Hi from goose")).toBeInTheDocument();
  expect(screen.getAllByText(/@Gander what's up\?/).length).toBeGreaterThan(0);
});

it("connects Goose through the host provider dialog using real provider/key/model controls", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    reply: "OK",
  });
  const setup = new GooseSetup(fake.spawn);
  const provider = new GooseProvider(setup, memoryStorage());
  const { ProviderDialogBody } = createTabs({ setup, provider, ...unused });
  const onClose = vi.fn();
  const type = {
    key: "buzz.goose/goose",
    pluginId: "buzz.goose",
    revision: "1",
    title: "Goose",
    provider: {
      snapshot: provider.snapshot,
      subscribe: provider.subscribe,
      check: provider.check,
      DialogBody: ProviderDialogBody,
    },
  } as RegisteredAgentType;
  render(
    <ProviderDialog type={type} finalFocus={createRef()} onClose={onClose} />,
  );
  expect(
    await screen.findByRole("combobox", { name: "Provider" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(provider.snapshot().readiness).toBe("ready");
  expect(
    fake.geese.some((goose) =>
      goose.turns.some((turn) => turn.text === "Reply with exactly: OK"),
    ),
  ).toBe(true);
});

it("applies an agent proposal to the real settings draft and saves only with the existing Save action", async () => {
  const fake = fakeSpawn({ providers: PROVIDERS });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake.spawn),
    ...unused,
  });
  const agent = {
    pubkey: "c".repeat(64),
    name: "Gander",
    type: "buzz.goose/goose",
    place: "here",
    config: {
      ...DEFAULT_CONFIG,
      instructions: "Keep context.",
      model: "chosen-model",
    },
  } as Agent<Config>;
  const proposal = {
    id: "proposal",
    type: agent.type,
    basedOn: "Keep context.",
    text: "Keep context. Use concise answers.",
  };
  const listeners = new Set<() => void>();
  let offered: typeof proposal | undefined = proposal;
  const save = vi.fn(async (_key: string, _change: unknown) => {});
  const agents = {
    save,
    instructionProposal: () => offered,
    subscribeInstructionProposals: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismissInstructionProposal: () => {
      offered = undefined;
      for (const listener of listeners) listener();
    },
  } as unknown as Agents;
  const section = agentSections({
    agents,
    agent,
    channels: [],
    memories: undefined,
    type: {
      tabs: [
        {
          id: "settings",
          role: "settings",
          title: "Settings",
          component: SettingsTab,
        },
      ],
    } as unknown as RegisteredAgentType,
    settingsHost: {},
  })[0];
  render(section?.render());
  const user = userEvent.setup();
  expect(screen.getByLabelText("Instructions")).toHaveValue("Keep context.");
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Apply to draft" }));
  expect(screen.getByLabelText("Instructions")).toHaveValue(proposal.text);
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(agent.pubkey, {
    config: expect.objectContaining({
      instructions: proposal.text,
      model: "chosen-model",
      workspace: DEFAULT_CONFIG.workspace,
    }),
  });
  expect(
    screen.queryByRole("region", { name: "Suggested instructions" }),
  ).toBeNull();
});
