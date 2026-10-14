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
import type { Agent } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { fakeSpawn } from "./goose-testing";
import { type Config, DEFAULT_CONFIG, type GooseRuntime } from "./runtime";
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
  const { Create, CreateModelMenu } = createTabs({
    setup: options.spawn?.(fake) ?? new GooseSetup(fake.spawn),
    ...unused,
  });
  if (!CreateModelMenu) throw new Error("no model menu");
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
        <MenuRoot>
          <MenuTrigger render={<Button>Goose</Button>} />
          <MenuPopup>
            <CreateModelMenu
              config={config}
              disabled={false}
              onChange={onChange}
              requestCustomModel={() => {}}
            />
          </MenuPopup>
        </MenuRoot>
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

/** Opens the provider dialog from the type menu. */
async function openChoices() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Goose" }));
  await user.click(
    await screen.findByRole("menuitem", {
      name: /Choose provider and model/,
    }),
  );
  return screen.findByRole("dialog", { name: "Provider and model" });
}

it("keeps New agent's card to instructions; goose's default leads the menu", async () => {
  created();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Goose" }));
  expect(
    await screen.findByRole("menuitemradio", {
      name: /goose default \(Databricks · goose-claude\)/,
    }),
  ).toHaveAttribute("aria-checked", "true");
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
  expect(changes.at(-1)).toMatchObject({ provider: "", model: "" });
  await user.click(within(dialog).getByRole("button", { name: "Use" }));
  expect(changes.at(-1)).toMatchObject({
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Goose" }));
  expect(
    await screen.findByRole("menuitemradio", {
      name: /Anthropic · claude-opus-5-5/,
    }),
  ).toHaveAttribute("aria-checked", "true");
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

it("says when goose-acp is not installed, and tries again", async () => {
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
    await within(dialog).findByText(/goose-acp is not installed/),
  ).toBeInTheDocument();
  installed = true;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).queryByText(/goose-acp is not installed/),
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
  await user.click(screen.getByRole("button", { name: "View transcript" }));
  expect(await screen.findByText("Hi from goose")).toBeInTheDocument();
  expect(screen.getAllByText(/@Gander what's up\?/).length).toBeGreaterThan(0);
});
