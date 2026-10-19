import { AgentTabs } from "../agents/AgentTabs";
import { ProviderDialog } from "../agents/ProviderDialog";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
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
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeDefaults } from "./defaults";

const desktop = vi.hoisted(() => ({ tauri: true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
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
  localStorage.clear();
  vi.restoreAllMocks();
});

const agent = (config: Config = DEFAULT_CONFIG) =>
  ({
    pubkey: "c".repeat(64),
    name: "Claude",
    type: "buzz.claude-code/claude-code",
    owner: "a".repeat(64),
    config,
  }) as Agent<Config>;

// jsdom leaves focus on a button that becomes natively disabled, where a
// browser drops it, so the focus tests also check for no `disabled`.

/** The models Claude lists in its answer to `initialize`. */
const CATALOG = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
];

/** Applies the plugin to a stand-in context; setup steps run until killed. */
function applied({
  loggedIn = true,
  available = true,
  version = "2.1.292",
  latest = version,
  files = {},
  catalog = { listed: true },
}: {
  loggedIn?: boolean;
  available?: boolean;
  version?: string;
  latest?: string;
  files?: Record<string, string>;
  /** Whether Claude lists its models when asked. */
  catalog?: { listed: boolean; ready?: Promise<void> };
} = {}) {
  let type: AgentType<Config> | undefined;
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    // Claude and its install steps run as steps of claude.sh: its script, $0
    // and step come first.
    const step = id === "claude-sh" ? options.args?.[2] : undefined;
    const name = step === "run" ? "claude" : (step ?? id);
    const args = (options.args ?? []).slice(step ? 3 : 0).join(" ");
    if (name === "find") {
      // Session files in the project folder that mention the pattern.
      const project = options.cwd?.split("/").pop();
      const [pattern = ""] = options.args ?? [];
      const found = Object.keys(files).filter(
        (path) =>
          path.startsWith(`./${project}/`) && files[path]?.includes(pattern),
      );
      queueMicrotask(() =>
        options.onStdout?.(
          found.map((path) => `./${path.split("/").pop()}\n`).join(""),
        ),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(() => resolve(found.length ? 0 : 1), 0),
        ),
      };
    }
    if (name === "workspace" || name === "read") {
      const file = files[args];
      queueMicrotask(() =>
        name === "workspace"
          ? options.onStdout?.("/Users/me/.buzz\n")
          : file === undefined
            ? options.onStderr?.(`base64: ${args}: No such file or directory`)
            : options.onStdout?.(btoa(file)),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(
            () => resolve(name === "read" && file === undefined ? 1 : 0),
            0,
          ),
        ),
      };
    }
    // Buzz's launcher answers 127 when it has no copy.
    const missing = name === "claude" && args === "--version" && !available;
    const streaming = args.includes("--input-format stream-json");
    let kill: () => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      if (name === "install" || args === "auth login" || streaming)
        kill = () => resolve(null);
      else setTimeout(() => resolve(missing ? 127 : 0), 0);
    });
    queueMicrotask(() =>
      options.onStdout?.(
        missing
          ? ""
          : name === "install"
            ? "Setting up Claude Code...\n"
            : name === "platform"
              ? "Darwin arm64\n"
              : args === "--version"
                ? `${version} (Claude Code)\n`
                : args === "auth status --json"
                  ? JSON.stringify({ loggedIn, email: "me@example.com" })
                  : "",
      ),
    );
    return {
      write: async (text: string) => {
        if (!streaming) return;
        const message = JSON.parse(text) as {
          request_id?: string;
          request?: { subtype?: string };
        };
        if (message.request?.subtype !== "initialize") return;
        await catalog.ready;
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: {
                  models: catalog.listed ? CATALOG : [],
                },
              },
            })}\n`,
          ),
        );
      },
      end: async () => undefined,
      kill: async () => kill(),
      exited,
    };
  });
  const ctx = {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    host: {
      spawn,
      // Offer the installed release unless the test requests an update.
      request: vi.fn(async ({ url }: { url: string }) => ({
        status: 200,
        headers: {},
        body: url.endsWith("/latest")
          ? latest
          : JSON.stringify({
              platforms: { "darwin-arm64": { checksum: "a".repeat(64) } },
            }),
      })),
    },
    agents: {
      register: (registered: AgentType<Config>) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () => undefined,
      subscribe: () => () => undefined,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return { type, spawn };
}
function installed(options?: Parameters<typeof applied>[0]) {
  const { type, spawn } = applied(options);
  if (!type) throw new Error("no type registered");
  return { type, spawn };
}
function tab(type: AgentType<Config>, index: number) {
  const component = type.tabs?.[index]?.component;
  if (!component) throw new Error("no tab");
  return component;
}
function providerSetup(type: AgentType<Config>) {
  if (!type.provider) throw new Error("no provider contribution");
  return type.provider.DialogBody;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("lists saved conversations and shows one's transcript, or that it is gone", async () => {
  const thread = `channel/${"e".repeat(64)}`;
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().pubkey]: {
        channel: { id: "deleted", seen: 0, at: 1 },
        [thread]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const transcript = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-09T10:00:00Z",
      message: {
        content:
          "<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>",
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "u2",
      timestamp: "2026-10-09T10:00:05Z",
      message: { content: [{ type: "text", text: "Two files." }] },
    }),
  ].join("\n");
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const save = vi.fn();
  render(<Activity agent={agent()} save={save} />);
  const user = userEvent.setup();
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("channel · thread eeeeeeee"),
    expect.stringContaining("channel · channel"),
  ]);
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: "View transcript" })[
      index
    ] as HTMLElement;
  await user.click(viewButton(0));
  expect(await screen.findByText("what changed?")).toBeVisible();
  expect(screen.getByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).not.toHaveAttribute(
      "data-loading",
    ),
  );
  expect(screen.getByText("Two files.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(viewButton(1));
  expect(
    await screen.findByText(/no transcript for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("sets the conversation the profile was opened from apart from recent conversations", () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().pubkey]: {
        channel: { id: "channel-session", seen: 0, at: 1 },
        [`channel/${root}`]: { id: "thread-session", seen: 0, at: 2 },
      },
    }),
  );
  const Activity = tab(installed().type, 1);
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  expect(
    within(opened).getByRole("button", { name: "View transcript" }),
  ).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText(/channel · channel/)).toBeVisible();
});

it("finds the thread's Claude session another build started", async () => {
  const root = "f".repeat(64);
  const started = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:00Z",
    message: {
      content: `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent().pubkey}\n</context>\n\n<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>`,
    },
  });
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/elsewhere.jsonl": started } }).type,
    1,
  );
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  fireEvent.click(
    await within(opened).findByRole("button", { name: "View transcript" }),
  );
  expect(await screen.findByText("what changed?")).toBeVisible();
});

it("is an agent type on the desktop app", () => {
  expect(inject).toEqual(["agents", "host"]);
  const { type } = installed();
  expect(type).toMatchObject({
    id: "claude-code",
    title: "Claude",
    icon: ClaudeLogoIcon,
  });
  expect(type.defaults()).toEqual({ config: DEFAULT_CONFIG });
  expect(
    type.adopt?.(
      { instructions: "Triage.", workspace: "~/code" },
      DEFAULT_CONFIG,
    ),
  ).toEqual({
    ...DEFAULT_CONFIG,
    instructions: "Triage.",
    workspace: "~/code",
  });
  expect(type.adopt?.({}, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  expect(type.carry?.(DEFAULT_CONFIG)).toEqual({});
  expect(
    type.carry?.({
      model: "opus",
      effort: "high",
      instructions: "Triage.",
      workspace: "~/code",
      scope: "channel",
    }),
  ).toEqual({ instructions: "Triage.", workspace: "~/code" });
  expect(type.describeMigration?.(DEFAULT_CONFIG)).toEqual([
    { id: "model", label: "Model", isOverride: false },
    { id: "thinking", label: "Thinking", isOverride: false },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: false,
      unchangedKey: "thread",
    },
  ]);
  expect(
    type.describeMigration?.({
      ...DEFAULT_CONFIG,
      model: "opus",
      effort: "high",
      scope: "channel",
    }),
  ).toEqual([
    { id: "model", label: "Model", isOverride: true },
    { id: "thinking", label: "Thinking", isOverride: true },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: true,
      unchangedKey: "channel",
    },
  ]);
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.provider).toBeDefined();
  expect(type.tabs?.map(({ title, role }) => [title, role])).toEqual([
    ["Settings", "settings"],
    ["Activity", "activity"],
  ]);
});

it("registers only where setup's bash and base64 exist", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied().type).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied().type).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied().type).toBeUndefined();
});

it("keeps provider readiness quiet and agent sessions out of Settings", async () => {
  const installedType = installed().type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Opus 5.5 · Default"),
  );
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  cleanup();
  const Settings = tab(installedType, 0);
  render(<Settings agent={agent()} save={vi.fn()} />);
  expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  expect(screen.queryByText("Recent conversations")).not.toBeInTheDocument();
  cleanup();
  const Activity = tab(installedType, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  expect(
    screen.getByText(/None\. A conversation's session starts/),
  ).toBeInTheDocument();
});

it("loads provider models inside a disabled picker without a loading subtitle", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const Provider = providerSetup(
    installed({ catalog: { listed: true, ready } }).type,
  );
  render(<Provider onClose={vi.fn()} />);
  try {
    const picker = await screen.findByRole("combobox", {
      name: "Default model",
    });
    await waitFor(() => expect(picker).toHaveTextContent("Loading models…"));
    expect(picker).toBeDisabled();
    expect(picker).toContainElement(screen.getByText("Loading models…"));
    expect(
      screen.queryByText("Loading Claude's models…"),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(picker);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await act(async () => finish());
    await waitFor(() => expect(picker).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Default model" })).toBe(
      picker,
    );
    expect(picker).toHaveTextContent("Opus 5.5 · Default");
    expect(screen.queryByText("Loading models…")).not.toBeInTheDocument();
  } finally {
    finish();
  }
});

it("saves a provider model default explicitly and leaves blank agent config inherited", async () => {
  const installedType = installed().type;
  const onClose = vi.fn();
  render(
    <ProviderDialog
      type={installedType as unknown as RegisteredAgentType}
      finalFocus={{ current: null }}
      onClose={onClose}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Opus 5.5 · Default"),
  );
  const user = userEvent.setup();
  const defaultModel = screen.getByRole("combobox", { name: "Default model" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  const saveDefaults = screen.getByRole("button", { name: "Save defaults" });
  const footer = saveDefaults.closest(".buzz-dialog-actions");
  expect(footer).not.toBeNull();
  expect(footer).toContainElement(cancel);
  expect(within(footer as HTMLElement).getAllByRole("button")).toEqual([
    cancel,
    saveDefaults,
  ]);
  expect(saveDefaults).toHaveAttribute(
    "form",
    defaultModel.closest("form")?.id,
  );
  expect(defaultModel).toHaveTextContent("Opus 5.5 · Default");
  await user.click(defaultModel);
  expect(
    await screen.findByRole("option", {
      name: "Opus 5.5 · Default",
    }),
  ).toHaveAccessibleDescription("Following Claude Code's recommendation");
  // Every model Claude lists is offered, not only the aliases.
  const fable = await screen.findByRole("option", { name: "Fable 5.1" });
  expect(fable).toHaveAccessibleDescription(
    "Most capable for your hardest tasks",
  );
  await user.click(fable);
  await user.click(screen.getByRole("button", { name: "Save defaults" }));
  expect(onClose).toHaveBeenCalledOnce();
  cleanup();

  const Settings = tab(installedType, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Fable 5.1",
    ),
  );
  expect(save).not.toHaveBeenCalled();
});

it("cancels a provider defaults draft without saving", async () => {
  const type = installed().type;
  const onClose = vi.fn();
  render(
    <ProviderDialog
      type={type as unknown as RegisteredAgentType}
      finalFocus={{ current: null }}
      onClose={onClose}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Opus 5.5 · Default"),
  );
  await choose("Default model", "Fable 5.1");
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(new ClaudeDefaults(localStorage).snapshot().model).toBe("");
});

it("closes a provider defaults draft without stopping a hidden background update", async () => {
  const { type, spawn } = installed({ latest: "2.1.293" });
  await waitFor(() =>
    expect(spawn).toHaveBeenCalledWith(
      "claude-sh",
      expect.objectContaining({ args: expect.arrayContaining(["install"]) }),
    ),
  );
  const installIndex = spawn.mock.calls.findIndex(
    ([, options]) => options?.args?.[2] === "install",
  );
  const installation = await spawn.mock.results[installIndex]?.value;
  if (!installation || !type.provider) throw new Error("No background update");
  const kill = vi.spyOn(installation, "kill");
  const onClose = vi.fn();
  try {
    render(
      <ProviderDialog
        type={type as unknown as RegisteredAgentType}
        finalFocus={{ current: null }}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Default model" }),
      ).toHaveTextContent("Opus 5.5 · Default"),
    );
    expect(type.provider.snapshot()).toMatchObject({
      readiness: "ready",
      blocking: true,
    });
    expect(screen.getByText("Setting up Claude Code...")).not.toBeVisible();
    await choose("Default model", "Fable 5.1");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(new ClaudeDefaults(localStorage).snapshot().model).toBe("");
    expect(kill).not.toHaveBeenCalled();
    expect(type.provider.snapshot()).toMatchObject({
      readiness: "ready",
      blocking: true,
    });
  } finally {
    await act(async () => installation.kill());
    await waitFor(() =>
      expect(type.provider?.snapshot().blocking).not.toBe(true),
    );
  }
});

it("says when Claude's models could not be loaded and tries again", async () => {
  const catalog = { listed: false };
  const Provider = providerSetup(installed({ catalog }).type);
  render(<Provider onClose={() => undefined} />);
  const defaultModel = await screen.findByRole("combobox", {
    name: "Default model",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't load Claude's models: Claude did not list its models",
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  catalog.listed = true;
  const user = userEvent.setup();
  await user.click(retry);
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  await user.click(defaultModel);
  expect(
    await screen.findByRole("option", { name: "Fable 5.1" }),
  ).toBeInTheDocument();
});

it("preserves native behavior for invalid defaults and keeps explicit agent models", () => {
  localStorage.setItem("buzz.claude-code.provider-defaults.v1", "not json");
  const defaults = new ClaudeDefaults(localStorage);
  expect(defaults.resolve(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  defaults.save({ model: "sonnet" });
  const inherited = { ...DEFAULT_CONFIG };
  expect(defaults.resolve(inherited).model).toBe("sonnet");
  expect(inherited).toEqual(DEFAULT_CONFIG);
  expect(defaults.resolve({ ...DEFAULT_CONFIG, model: "opus" }).model).toBe(
    "opus",
  );
});

it("can cancel sign-in and try again", async () => {
  const installedType = installed({ loggedIn: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude 2.1.292 needs you to sign in.",
    ),
  );
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(installedType.provider?.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Log in to Claude Code",
  });
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  await user.click(signIn);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Claude Code sign-in…",
    ),
  );
  expect(screen.getByLabelText("Sign-in code")).toHaveAccessibleDescription(
    "If the browser shows a code to paste, enter it here.",
  );
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(installedType.provider?.snapshot()).toHaveProperty("blocking", true);
  await user.click(cancel);
  const retry = await screen.findByRole("button", { name: "Sign in" });
  expect(installedType.provider?.snapshot()).not.toHaveProperty("blocking");
  expect(retry).toHaveFocus();
  await user.click(retry);
  expect(await screen.findByRole("button", { name: "Cancel" })).toBeVisible();
});

it("replaces generic installation copy with the latest installer state", async () => {
  const installedType = installed({ available: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Claude is not installed.",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Install Claude" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Setting up Claude Code...",
    ),
  );
  expect(screen.queryByText("Installing Claude Code…")).toBeNull();
  expect(screen.queryByLabelText("Setup output")).toBeNull();
});

it("starts viable provider recovery directly from its attention action", async () => {
  const { type, spawn } = installed({ loggedIn: false });
  const Setup = providerSetup(type);
  render(<Setup onClose={vi.fn()} />);
  await waitFor(() =>
    expect(type.provider?.snapshot()).toMatchObject({
      readiness: "attention",
      attentionLabel: "Log in to Claude Code",
    }),
  );
  // Offered once the update check on load has finished.
  await waitFor(() =>
    expect(type.provider?.attentionAction).toBeTypeOf("function"),
  );
  const action = type.provider?.attentionAction;
  act(() => action?.());
  await waitFor(() =>
    expect(spawn).toHaveBeenCalledWith(
      "claude-sh",
      expect.objectContaining({
        args: [expect.any(String), "claude.sh", "run", "auth", "login"],
      }),
    ),
  );
  expect(type.provider?.attentionAction).toBeUndefined();
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for Claude Code sign-in…",
    ),
  );
  expect(type.provider?.snapshot()).toHaveProperty("blocking", true);
});

it("saves settings as one config", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  const sonnet = await screen.findByRole("option", { name: "Sonnet 5.5" });
  expect(sonnet).toHaveAccessibleDescription("Efficient for routine tasks");
  await user.click(sonnet);
  expect(screen.getByLabelText("Workspace")).toHaveAccessibleDescription(
    "The folder Claude works in. Use ~/ for your home folder.",
  );
  await user.clear(screen.getByLabelText("Workspace"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "sonnet",
    workspace: "~/.buzz",
  });
});

it("offers the model's thinking levels, dropping one the next model lacks", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Sonnet 5.5" }));
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Automatic · Default", "Low", "Medium", "High", "Extra high"]);
  await user.click(screen.getByRole("option", { name: "Extra high" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "haiku",
    effort: "high",
  });
});

it("keeps a saved thinking level changeable without Claude's model list", async () => {
  const Settings = tab(installed({ catalog: { listed: false } }).type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, effort: "high" })}
      save={save}
    />,
  );
  const user = userEvent.setup();
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("High");
  expect(thinking).not.toHaveTextContent("unavailable");
  await user.click(thinking);
  await user.click(
    await screen.findByRole("option", { name: "Automatic · Default" }),
  );
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
});

it("keeps Save focused while saving, and lets a failed save be retried", async () => {
  const Settings = tab(installed().type, 0);
  let fail: (error: Error) => void = () => undefined;
  const save = vi
    .fn<(config: Config) => Promise<void>>()
    .mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    .mockResolvedValueOnce(undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await choose("Model", "Haiku 4.5");
  const saveButton = screen.getByRole("button", { name: "Save" });
  await user.click(saveButton);
  expect(saveButton).toHaveAttribute("aria-busy", "true");
  expect(saveButton).toHaveFocus();
  expect(saveButton).not.toHaveAttribute("disabled");
  fail(new Error("Relay rejected the change"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay rejected the change",
  );
  expect(screen.getByRole("alert")).toHaveFocus();
  await user.click(saveButton);
  expect(save).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("starts a new agent with finite model choices and preserves its other settings", async () => {
  const { type } = installed();
  const Create = type.Create;
  const Model = type.CreateModel;
  if (!Create || !Model) throw new Error("Missing creation controls");
  const config = {
    ...DEFAULT_CONFIG,
    workspace: "~/code",
    scope: "channel" as const,
    instructions: "Triage.",
  };
  const onChange = vi.fn();
  render(
    <>
      <Create config={config} onChange={onChange} disabled={false} />
      <Model config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const picker = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(picker).toBeEnabled());
  const user = userEvent.setup();
  await user.click(picker);
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(
    await screen.findByRole("option", {
      name: "Opus 5.5 · Default",
      description: "Best for everyday, complex tasks",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({ ...config, model: "" });
  expect(screen.getByLabelText("Instructions Optional")).toHaveValue("Triage.");
  fireEvent.change(screen.getByLabelText("Instructions Optional"), {
    target: { value: "Plan." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Plan.",
  });
});

it("disables a new agent's controls while it is being created", () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create choices");
  render(<Create config={DEFAULT_CONFIG} onChange={vi.fn()} disabled />);
  expect(screen.getByLabelText("Instructions Optional")).toBeDisabled();
});

it("edits a custom model and instructions in settings", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, model: "claude-opus-4-1" })}
      save={save}
      settingsHost={{ typeControl: () => <p>Provider control</p> }}
    />,
  );
  const user = userEvent.setup();
  const providerControl = screen.getByText("Provider control");
  const modelControl = screen.getByRole("combobox", { name: "Model" });
  expect(
    providerControl.compareDocumentPosition(modelControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(modelControl).toHaveTextContent("claude-opus-4-1");
  expect(
    screen.getByLabelText("Instructions"),
  ).not.toHaveAccessibleDescription();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  const modelId = await screen.findByRole("textbox", { name: "Model ID" });
  expect(modelId).toHaveValue("claude-opus-4-1");
  await user.clear(modelId);
  await user.type(modelId, "claude-sonnet-custom");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    model: "claude-sonnet-custom",
    instructions: "Triage.",
  });
});

it("keeps settings editable while a provider change waits for Save", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent()}
      save={save}
      settingsHost={{
        pendingSave: async () => {},
      }}
    />,
  );
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
});

it("shares one customization-free discovery across cards and workspace changes", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  const cards = (workspace: string) => (
    <StrictMode>
      {[1, 2, 3].map((id) => (
        <Model
          key={id}
          config={{ ...DEFAULT_CONFIG, workspace }}
          disabled={false}
          onChange={vi.fn()}
        />
      ))}
    </StrictMode>
  );
  const view = render(cards("/project-with-hooks"));
  await waitFor(() =>
    expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(3),
  );
  view.rerender(cards("/other-project"));
  view.unmount();
  render(cards("/third-project"));
  await screen.findAllByRole("combobox", { name: "Model" });
  const probes = spawn.mock.calls.filter(([, options]) =>
    options?.args?.includes("--input-format"),
  );
  expect(probes).toHaveLength(1);
  expect(probes[0]?.[1]).toMatchObject({
    cwd: "~",
    args: expect.arrayContaining([
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
    ]),
  });
  expect(probes[0]?.[1]?.args).not.toContain("bypassPermissions");
});

it("does not open a competing Claude sign-in or let it cancel the owner", async () => {
  const { type, spawn } = installed({ loggedIn: false });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(
    [1, 2].map((id) => (
      <Model
        key={id}
        config={DEFAULT_CONFIG}
        disabled={false}
        onChange={vi.fn()}
      />
    )),
  );
  await waitFor(() => {
    const buttons = screen.getAllByRole("button", { name: "Sign in" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeEnabled();
  });
  const buttons = screen.getAllByRole("button", { name: "Sign in" });
  if (!buttons[0] || !buttons[1]) throw new Error("Missing sign-in");
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(
    spawn.mock.calls.filter(
      ([, options]) => options?.args?.slice(-2).join(" ") === "auth login",
    ),
  ).toHaveLength(1);
  expect(
    screen.getAllByRole("dialog", { name: "Sign in to Claude" }),
  ).toHaveLength(1);
  expect(buttons[1]).toBeDisabled();
});

it("offers an update before discovering models on a pre-safe-mode Claude copy", async () => {
  const { type, spawn } = installed({ version: "2.1.168" });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(<Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Update Claude" })).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(
    spawn.mock.calls.filter(([, options]) =>
      options?.args?.includes("--safe-mode"),
    ),
  ).toHaveLength(0);
});

it("separates identity fields from runtime settings without changing the stored config", () => {
  const Settings = tab(installed().type, 0);
  const props = { agent: agent(), save: vi.fn(async () => undefined) };
  const view = render(<Settings {...props} settingsSection="identity" />);
  const instructions = screen.getByLabelText("Instructions");
  const model = screen.getByLabelText("Model");
  expect(
    model.compareDocumentPosition(instructions) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Sessions")).not.toBeInTheDocument();
  expect(screen.queryByText("Runtime diagnostics")).not.toBeInTheDocument();
  view.rerender(<Settings {...props} settingsSection="runtime" />);
  expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  expect(screen.getByLabelText("Sessions")).toBeInTheDocument();
  expect(screen.queryByText("Runtime diagnostics")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  expect(props.save).not.toHaveBeenCalled();
});

it.each([
  { available: true, action: "Sign in", title: "Sign in to Claude" },
  { available: false, action: "Install Claude", title: "Set up Claude" },
])(
  "keeps failed Claude $action output in its open dialog",
  async ({ available, action, title }) => {
    const { type, spawn } = installed({ loggedIn: false, available });
    const Model = type.CreateModel;
    if (!Model) throw new Error("Missing model field");
    render(
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />,
    );
    const signIn = await screen.findByRole("button", { name: action });
    await waitFor(() => expect(signIn).toBeEnabled());
    const original = spawn.getMockImplementation();
    if (!original) throw new Error("Missing spawn implementation");
    spawn.mockImplementation(async (id, options = {}) => {
      if (
        options.args?.includes("install") ||
        options.args?.slice(-2).join(" ") === "auth login"
      )
        throw new Error("Setup could not start");
      return original(id, options);
    });
    fireEvent.click(signIn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: action })).toBeEnabled(),
    );
    const dialog = await screen.findByRole("dialog", { name: title });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Setup details" }),
    );
    expect(await within(dialog).findByRole("log")).toHaveTextContent(
      "Setup could not start",
    );
  },
);

it("keeps the shared Claude catalog across repeated provider checks", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  if (!Model || !type.provider) throw new Error("Missing provider");
  render(
    <>
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />
    </>,
  );
  await screen.findAllByRole("combobox", { name: "Model" });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await type.provider?.check();
    });
  expect(
    spawn.mock.calls.filter(([, options]) =>
      options?.args?.includes("--input-format"),
    ),
  ).toHaveLength(1);
  expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(2);
});

it.each(["Identity", "Settings"])(
  "preserves both settings drafts and retries a failed save from %s",
  async (saveFrom) => {
    const f = installed();
    const Settings = tab(f.type, 0);
    const source = agent();
    const user = userEvent.setup();
    const savedAgent = { ...source, place: "here" as const };
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValue(undefined);
    const agents = {
      save,
      configHistory: () => undefined,
    } as unknown as Agents;
    const type = {
      tabs: [
        {
          id: "settings",
          title: "Settings",
          role: "settings",
          splitSettings: true,
          component: Settings,
        },
      ],
    } as unknown as RegisteredAgentType;
    render(
      <AgentTabs
        agents={agents}
        agent={savedAgent}
        type={type}
        settingsHost={{}}
        channels={[]}
        memories={undefined}
        settingsContent={<p>Agent details</p>}
      />,
    );
    await user.clear(screen.getByLabelText("Instructions"));
    await user.type(
      screen.getByLabelText("Instructions"),
      "Keep this identity draft.",
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.clear(screen.getByLabelText("Workspace"));
    await user.type(screen.getByLabelText("Workspace"), "/tmp/combined-draft");
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    await user.click(screen.getByRole("tab", { name: "Identity" }));
    expect(screen.getByLabelText("Instructions")).toHaveValue(
      "Keep this identity draft.",
    );
    if (saveFrom === "Settings")
      await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenLastCalledWith(savedAgent.pubkey, {
      config: expect.objectContaining({
        instructions: "Keep this identity draft.",
        workspace: "/tmp/combined-draft",
      }),
    });
  },
);
