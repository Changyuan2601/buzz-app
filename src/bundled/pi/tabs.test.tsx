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
import { type Config, DEFAULT_CONFIG, type Place } from "./runtime";
import { type Provider, type Providers, PiSetup } from "./setup";
import { createTabs } from "./tabs";
import { piTurns } from "./transcript";

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

const MODELS: Record<
  string,
  { id: string; name: string; thinking: string[] }[]
> = {
  anthropic: [{ id: "claude-x", name: "Claude X", thinking: ["off", "high"] }],
  openai: [{ id: "gpt-x", name: "GPT X", thinking: ["off", "low"] }],
};

/** The Pi host's answers to setup's requests; `fail` makes one throw. */
function fakePi(
  fail: Partial<Record<string, string>> = {},
  defaults: Providers["defaults"] = {
    provider: "anthropic",
    model: "claude-x",
  },
) {
  const providers: Provider[] = [
    {
      id: "anthropic",
      name: "Anthropic",
      key: true,
      signsIn: true,
      configured: "auth.json",
    },
    { id: "openai", name: "OpenAI", key: true, signsIn: false },
    { id: "copilot", name: "GitHub Copilot", key: false, signsIn: true },
  ];
  const request = vi.fn(
    async (method: string, params: Record<string, string> = {}) => {
      const failure = fail[method];
      if (failure) throw new Error(failure);
      if (method === "providers")
        return {
          providers: providers.map((item) => ({ ...item })),
          defaults,
        };
      if (method === "models") return MODELS[params.provider ?? ""] ?? [];
      if (method === "login") {
        const index = providers.findIndex(
          (item) => item.id === params.provider,
        );
        const found = providers[index];
        if (found) providers[index] = { ...found, configured: "auth.json" };
        return {};
      }
      if (method === "test")
        return { ok: true, message: `Connected to ${params.model}` };
      throw new Error(`Unexpected ${method}`);
    },
  );
  type Request = ConstructorParameters<typeof PiSetup>[0]["request"];
  return { request: request as unknown as Request, calls: request };
}

/** The runtime's conversations: a thread Pi works in, and a channel. */
function fakeRuntime() {
  const places: Place[] = [
    {
      key: "chan/root",
      conversation: 1,
      channelId: "chan",
      root: "root",
      name: "general",
      at: 2_000,
    },
    { key: "other", conversation: 2, channelId: "other", at: 1_000 },
  ];
  const working = [1];
  return {
    places: vi.fn(async () => places),
    working: () => working,
    subscribe: () => () => {},
    transcript: vi.fn(async (_agent: string, place: Place) => ({
      turns: piTurns(
        [
          {
            id: 1,
            kind: "pi.user",
            model: [
              {
                role: "user",
                content: `Hello from ${place.key}`,
                timestamp: 1,
              },
            ],
          },
          {
            id: 2,
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Hi there" }],
                timestamp: 2,
              },
            ],
          },
        ],
        place,
        true,
      ),
      unknownThread: 0,
      more: false,
    })),
  };
}

function created(pi = fakePi()) {
  const { Create, CreateModel } = createTabs({
    setup: new PiSetup(pi),
    runtime: fakeRuntime(),
  });
  const changes: Config[] = [];
  function Harness() {
    const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
    const onChange = (next: Config) => {
      changes.push(next);
      setConfig(next);
    };
    // As New agent shows them: the Model row, then the type's own choices.
    return (
      <>
        <CreateModel config={config} disabled={false} onChange={onChange} />
        <Create config={config} disabled={false} onChange={onChange} />
      </>
    );
  }
  render(<Harness />);
  return { pi, changes };
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Opens the provider dialog from the Model field. */
async function openChoices() {
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Provider…" }));
  return screen.findByRole("dialog", { name: "Provider and model" });
}

it("starts New agent's Model field on Pi's default, with the provider kept to its dialog", async () => {
  created();
  expect(screen.queryByRole("combobox", { name: "Model provider" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Pi default (Anthropic · claude-x)",
    ),
  );
  expect(screen.getByLabelText("Describe what I should do")).toBeVisible();
});

it("saves a provider's key with Pi's login, needs a model for it, and tests it", async () => {
  const { pi, changes } = created();
  const user = userEvent.setup();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Model provider" }),
    ).toHaveTextContent("From Pi settings (Anthropic)"),
  );
  expect(within(dialog).getByText("Anthropic is set up in Pi.")).toBeVisible();

  await choose("Model provider", "OpenAI");
  const key = await within(dialog).findByLabelText("API key");
  expect(key).toHaveAttribute("type", "password");
  await user.type(key, "sk-test");
  await user.click(within(dialog).getByRole("button", { name: "Save to Pi" }));
  await waitFor(() =>
    expect(within(dialog).getByText("OpenAI is set up in Pi.")).toBeVisible(),
  );
  expect(pi.calls).toHaveBeenCalledWith("login", {
    provider: "openai",
    key: "sk-test",
  });

  // Pi's settings give no model for a provider they do not name.
  const use = within(dialog).getByRole("button", { name: "Use" });
  expect(use).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByText(
      "Pi's settings name no model for OpenAI. Choose one.",
    ),
  ).toBeVisible();
  await choose("Model", "GPT X");
  await user.click(
    within(dialog).getByRole("button", { name: "Test connection" }),
  );
  expect(await within(dialog).findByRole("status")).toHaveTextContent(
    "Connected to gpt-x",
  );
  expect(pi.calls).toHaveBeenCalledWith("test", {
    provider: "openai",
    model: "gpt-x",
  });
  // Nothing reaches the agent until the choice is used.
  expect(changes).toEqual([]);
  await user.click(use);
  expect(changes.at(-1)).toMatchObject({ provider: "openai", model: "gpt-x" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "GPT X",
    ),
  );
});

it("sends a provider that signs in without a key to the pi command", async () => {
  created();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Model provider" }),
    ).toBeEnabled(),
  );
  await choose("Model provider", "GitHub Copilot");
  expect(
    within(dialog).getByText(/GitHub Copilot signs in through Pi/),
  ).toBeVisible();
  expect(within(dialog).queryByLabelText("API key")).toBeNull();
});

it("says why Pi could not start, and tries again", async () => {
  const fail: Record<string, string> = {
    providers:
      "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.",
  };
  created(fakePi(fail));
  const dialog = await openChoices();
  expect(
    await within(dialog).findByText(/Pi needs Node\.js 22\.19 or later/),
  ).toBeVisible();
  delete fail.providers;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Model provider" }),
    ).toHaveTextContent("From Pi settings (Anthropic)"),
  );
});

it("says Buzz can't use a default provider that a Pi package adds", async () => {
  created(fakePi({}, { provider: "databricks", model: "databricks-x" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "databricks isn't built into Pi, so Buzz can't use it",
  );
  expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
  const dialog = await openChoices();
  const provider = within(dialog).getByRole("combobox", {
    name: "Model provider",
  });
  await waitFor(() => expect(provider).toBeEnabled());
  expect(provider).toHaveAccessibleDescription(
    /Buzz can use only Pi's built-in providers, and databricks isn't one/,
  );
  const use = within(dialog).getByRole("button", { name: "Use" });
  expect(use).toHaveAttribute("aria-disabled", "true");
  expect(
    within(dialog).getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();

  await choose("Model provider", "Anthropic");
  expect(provider).not.toHaveAccessibleDescription(/built-in providers/);
  await choose("Model", "Claude X");
  expect(use).not.toHaveAttribute("aria-disabled", "true");
});

const AGENT = {
  pubkey: "c".repeat(64),
  name: "pii",
  type: "buzz.pi/pi",
  owner: "a".repeat(64),
  config: DEFAULT_CONFIG,
} as Agent<Config>;

it("keeps Try again's providers for what the dialog's Use allows", async () => {
  const fail: Record<string, string> = { providers: "Pi stopped" };
  created(fakePi(fail, { provider: "databricks", model: "databricks-x" }));
  const dialog = await openChoices();
  expect(await within(dialog).findByText("Pi stopped")).toBeVisible();
  delete fail.providers;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Model provider" }),
    ).toHaveAccessibleDescription(/databricks isn't one/),
  );
  expect(within(dialog).getByRole("button", { name: "Use" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("saves a key on Enter without saving the agent's settings", async () => {
  const pi = fakePi();
  const { SettingsTab } = createTabs({
    setup: new PiSetup(pi),
    runtime: fakeRuntime(),
  });
  const save = vi.fn();
  render(<SettingsTab agent={AGENT} save={save} />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Model provider" }),
    ).toBeEnabled(),
  );
  await choose("Model provider", "OpenAI");
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("API key"), "sk-test{Enter}");
  expect(await screen.findByText("OpenAI is set up in Pi.")).toBeVisible();
  expect(pi.calls).toHaveBeenCalledWith("login", {
    provider: "openai",
    key: "sk-test",
  });
  expect(save).not.toHaveBeenCalled();
});

it("lists Pi's conversations in the Activity tab, and shows a transcript", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({ setup: new PiSetup(fakePi()), runtime });
  render(
    <ActivityTab
      agent={AGENT}
      conversation={{ channelId: "chan", rootId: "root" }}
    />,
  );
  const user = userEvent.setup();
  const here = await screen.findByRole("region", { name: "This thread" });
  expect(here).toHaveTextContent("#general");
  expect(here).toHaveTextContent("Working");
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    [expect.stringContaining("other · channel")],
  );

  await user.click(
    within(here).getByRole("button", { name: "View transcript" }),
  );
  expect(await screen.findByText("Hello from chan/root")).toBeVisible();
  expect(screen.getByText("Hi there")).toBeVisible();
  expect(runtime.transcript).toHaveBeenLastCalledWith(
    "c".repeat(64),
    expect.objectContaining({ conversation: 1 }),
    true,
    expect.any(AbortSignal),
  );
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(
    within(screen.getByRole("listitem")).getByRole("button", {
      name: "View transcript",
    }),
  );
  expect(await screen.findByText("Hello from other")).toBeVisible();
});
