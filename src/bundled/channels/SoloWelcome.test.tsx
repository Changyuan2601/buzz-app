// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { WelcomeNextSteps } from "./WelcomeNextSteps";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SoloWelcome, WelcomeControls } from "./SoloWelcome";
import { AgentsContext } from "../../features/agents/react";
import {
  readWelcome,
  saveWelcome,
  useWelcomeReceipt,
} from "../../features/sessions/welcome";
import { readDefaultAgent } from "../../features/solo/default-agent";
import type {
  Agents,
  Agent,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";

stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const agentKey = "a".repeat(64);
const channelId = "11111111-1111-4111-8111-111111111111";
const receipt = { type: "claude/claude", agent: agentKey, channelId };
function fixture(suggestNames?: RegisteredAgentType["suggestNames"]) {
  let agent = {
    pubkey: agentKey,
    name: "Welcome",
    type: receipt.type,
  } as Agent;
  const listeners = new Set<() => void>();
  const type = {
    key: receipt.type,
    pluginId: "claude",
    revision: "1",
    id: "claude",
    title: "Claude",
    defaults: () => ({ config: {} }),
    startConversation: async () => ({ ok: true }),
    ...(suggestNames ? { suggestNames } : {}),
  } as RegisteredAgentType;
  const types = [type];
  const emptyWindow = { status: "ready", rows: [] };
  let snapshot = { status: "ready", agents: [agent] };
  const agents = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: () => agent,
    types: () => types,
    welcome: vi.fn(async () => ({ id: "b".repeat(64) })),
    save: vi.fn(async (_key: string, change: { name?: string }) => {
      agent = { ...agent, ...change };
      snapshot = { status: "ready", agents: [agent] };
      for (const listener of listeners) listener();
    }),
  } as unknown as Agents;
  const session = {
    read: vi.fn(async () => []),
    channels: {
      window: () => emptyWindow,
      subscribeWindow: () => () => {},
      ensure: vi.fn(),
    },
  } as unknown as RelaySession;
  return { agents, session, types };
}

it("offers only the providers that can finish Welcome, in the provider's own setup words", async () => {
  const f = fixture();
  const health = { readiness: "ready" as const };
  const check = vi.fn();
  const claude = f.types[0];
  if (!claude) throw new Error("Missing Claude fixture");
  const provider = {
    snapshot: () => health,
    subscribe: () => () => {},
    check,
    DialogBody: () => <p>Claude setup</p>,
  };
  f.types[0] = { ...claude, provider };
  const { startConversation: _start, ...placeholder } = claude;
  const placeholderCheck = vi.fn();
  f.types.push(
    ...["Codex", "Goose"].map((title) => ({
      ...claude,
      key: `test/${title.toLowerCase()}`,
      title,
      provider,
    })),
    {
      ...placeholder,
      key: "test/builderlab",
      title: "Builderlab",
      provider: { ...provider, check: placeholderCheck },
    },
  );
  render(
    <AgentsContext.Provider value={f.agents}>
      <SoloWelcome
        session={f.session}
        scope="scope"
        signal={new AbortController().signal}
        onCreated={() => {}}
      />
    </AgentsContext.Provider>,
  );
  expect(
    screen.getByText(
      "This is a space to think things through, ask questions, and get work done with your agents. Start by connecting your AI provider.",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Configure Claude" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("heading", { name: "Welcome to Buzz", level: 1 }),
  ).toBeVisible();
  expect(screen.getByText("Welcome", { selector: "strong" })).toBeVisible();
  expect(
    screen.getByRole("img", { name: "Welcome placeholder" }),
  ).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Message your agent" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Message your agent" }),
  ).toHaveAttribute(
    "placeholder",
    "Connect your AI provider to start chatting",
  );
  expect(
    screen.queryByText("Connect your AI provider to start chatting"),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(screen.getAllByRole("button", { name: "Continue" })).toHaveLength(3);
  for (const title of ["Codex", "Goose"]) {
    expect(
      screen.getByRole("button", { name: `Configure ${title}` }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: `Configure ${title}` }),
    );
    expect(await screen.findByRole("dialog", { name: title })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  expect(
    screen.getByRole("heading", { name: "Connect your AI provider" }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Configure Claude" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Claude" }),
  ).toHaveTextContent("Claude setup");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // A type that cannot deliver the introduction is not offered here at all,
  // and onboarding neither checks nor advertises its setup.
  for (const title of ["Builderlab"]) {
    expect(screen.queryByText(title)).toBeNull();
    expect(
      screen.queryByRole("button", { name: `Connect ${title}` }),
    ).toBeNull();
  }
  expect(
    screen.getByText("Builderlab agents can be added in Agents later."),
  ).toBeVisible();
  expect(placeholderCheck).not.toHaveBeenCalled();
  expect(check).toHaveBeenCalled();
  expect(f.agents.welcome).not.toHaveBeenCalled();
});

it("hands an unready provider its own recovery action instead of creating anything", async () => {
  const f = fixture();
  const claude = f.types[0];
  if (!claude) throw new Error("Missing Claude fixture");
  const listeners = new Set<() => void>();
  let health = {
    readiness: "attention" as const,
    attentionLabel: "Install Claude Code",
    blocking: false,
  };
  const attentionAction = vi.fn(() => {
    health = { ...health, blocking: true };
    for (const listener of listeners) listener();
  });
  f.types[0] = {
    ...claude,
    provider: {
      snapshot: () => health,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check: vi.fn(),
      attentionAction,
      DialogBody: () => <p>Claude setup</p>,
    },
  };
  render(
    <AgentsContext.Provider value={f.agents}>
      <SoloWelcome
        session={f.session}
        scope="scope"
        signal={new AbortController().signal}
        onCreated={() => {}}
      />
    </AgentsContext.Provider>,
  );
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Install Claude Code" }),
  );
  expect(attentionAction).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  // Running setup reports itself and stops offering the same action again.
  expect(await screen.findByText("Setting up…")).toBeVisible();
  const progress = screen.getByRole("button", { name: "Show Claude setup" });
  await userEvent.click(progress);
  expect(
    await screen.findByRole("dialog", { name: "Claude" }),
  ).toHaveTextContent("Claude setup");
  expect(attentionAction).toHaveBeenCalledTimes(1);
  expect(f.agents.welcome).not.toHaveBeenCalled();
});

it("states a real next step when no provider can finish Welcome", () => {
  const f = fixture();
  f.types.length = 0;
  render(
    <AgentsContext.Provider value={f.agents}>
      <SoloWelcome
        session={f.session}
        scope="scope"
        signal={new AbortController().signal}
        onCreated={() => {}}
      />
    </AgentsContext.Provider>,
  );
  expect(
    screen.getByText(
      "No AI provider on this device can set up your agent yet. Turn on an agent plugin in Settings → Plugins to continue.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

it("starts once across StrictMode/reopen and saves the actual agent name before confirming the default", async () => {
  const f = fixture();
  saveWelcome("scope", receipt);
  const controller = new AbortController();
  const view = render(
    <StrictMode>
      <WelcomeControls
        {...f}
        scope="scope"
        signal={controller.signal}
        receipt={receipt}
        onSaved={() => {}}
      />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(readWelcome("scope")?.replyId).toBe("b".repeat(64)),
  );
  expect(f.agents.welcome).toHaveBeenCalledTimes(1);
  view.unmount();
  const observed = readWelcome("scope");
  if (!observed) throw new Error("Missing setup receipt");
  const onSaved = vi.fn();
  render(
    <WelcomeControls
      {...f}
      scope="scope"
      signal={controller.signal}
      receipt={observed}
      onSaved={onSaved}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  expect(name).toHaveFocus();
  await userEvent.type(name, " Welcome ");
  expect(screen.getByRole("button", { name: /Looks good/ })).toBeDisabled();
  expect(f.agents.save).not.toHaveBeenCalled();
  await userEvent.clear(name);
  await userEvent.type(name, "Ada");
  await userEvent.click(screen.getByRole("button", { name: /Looks good/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(f.agents.save).toHaveBeenCalledWith(
    agentKey,
    expect.objectContaining({ name: "Ada" }),
  );
  expect(readDefaultAgent("scope")).toBe(agentKey);
  expect(readWelcome("scope")?.complete).toBe(true);
  expect(f.agents.welcome).toHaveBeenCalledTimes(1);
});

it("never repeats an uncertain kickoff automatically and does not claim a failed rename was saved", async () => {
  const f = fixture();
  const uncertain = {
    ...receipt,
    kickoff: "attempted" as const,
    kickoffAt: 100,
  };
  saveWelcome("scope", uncertain);
  const view = render(
    <WelcomeControls
      {...f}
      scope="scope"
      signal={new AbortController().signal}
      receipt={uncertain}
      onSaved={() => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Check and retry introduction" }),
  ).toBeVisible();
  expect(f.agents.welcome).not.toHaveBeenCalled();
  view.unmount();
  const observed = { ...uncertain, replyId: "c".repeat(64) };
  vi.mocked(f.agents.save).mockRejectedValueOnce(
    new Error("Could not save name"),
  );
  render(
    <WelcomeControls
      {...f}
      scope="scope"
      signal={new AbortController().signal}
      receipt={observed}
      onSaved={() => {}}
    />,
  );
  await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Pip");
  await userEvent.click(screen.getByRole("button", { name: /Looks good/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save name",
  );
  expect(readDefaultAgent("scope")).toBeUndefined();
  expect(readWelcome("scope")?.complete).not.toBe(true);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Pip");
});

it("prefills a generated name and avatar, shuffles both from the batch, and only saves on confirmation", async () => {
  const suggest = vi.fn(async () => ["Quibble", "Tumble"]);
  const f = fixture(suggest);
  const observed = {
    ...receipt,
    kickoff: "observed" as const,
    replyId: "c".repeat(64),
  };
  saveWelcome("scope", observed);
  const onSaved = vi.fn();
  render(
    <WelcomeControls
      {...f}
      scope="scope"
      signal={new AbortController().signal}
      receipt={observed}
      onSaved={onSaved}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  await waitFor(() => expect(name).toHaveValue("Quibble"));
  const firstAvatar = screen
    .getByRole("button", { name: "Change avatar" })
    .querySelector("img")
    ?.getAttribute("src");
  expect(firstAvatar).toBeTruthy();
  expect(f.agents.save).not.toHaveBeenCalled();
  expect(readDefaultAgent("scope")).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  expect(name).toHaveValue("Tumble");
  expect(
    screen
      .getByRole("button", { name: "Change avatar" })
      .querySelector("img")
      ?.getAttribute("src"),
  ).not.toBe(firstAvatar);
  expect(suggest).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: /Looks good/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(f.agents.save).toHaveBeenCalledWith(
    agentKey,
    expect.objectContaining({ name: "Tumble", picture: expect.any(String) }),
  );
  expect(f.agents.welcome).not.toHaveBeenCalled();
});

it("keeps manual edits when a name suggestion arrives late and recovers from a provider failure", async () => {
  let release!: (names: readonly string[]) => void;
  const suggest = vi.fn(
    () =>
      new Promise<readonly string[]>((resolve) => {
        release = resolve;
      }),
  );
  const f = fixture(suggest);
  const observed = {
    ...receipt,
    kickoff: "observed" as const,
    replyId: "c".repeat(64),
  };
  saveWelcome("scope", observed);
  render(
    <WelcomeControls
      {...f}
      scope="scope"
      signal={new AbortController().signal}
      receipt={observed}
      onSaved={() => {}}
    />,
  );
  await waitFor(() => expect(suggest).toHaveBeenCalledOnce());
  const name = screen.getByRole("textbox", { name: "Name" });
  await userEvent.type(name, "My choice");
  release(["Late name"]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Shuffle" })).not.toBeDisabled(),
  );
  expect(name).toHaveValue("My choice");
  suggest.mockImplementationOnce(async () => {
    throw new Error("Provider unavailable");
  });
  await userEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Provider unavailable",
  );
  expect(name).toHaveValue("My choice");
  expect(f.agents.save).not.toHaveBeenCalled();
});

it("reconciles a top-level introduction behind a newer threaded reply without starting another turn", async () => {
  const f = fixture();
  const attempted = {
    ...receipt,
    kickoff: "attempted" as const,
    kickoffAt: 100,
  };
  saveWelcome("scope", attempted);
  vi.mocked(f.session.read).mockResolvedValue([
    {
      id: "d".repeat(64),
      pubkey: agentKey,
      kind: 9,
      created_at: 102,
      content: "thread",
      tags: [
        ["h", channelId],
        ["e", "thread"],
      ],
    },
    {
      id: "e".repeat(64),
      pubkey: agentKey,
      kind: 9,
      created_at: 101,
      content: "introduction",
      tags: [["h", channelId]],
    },
  ]);
  render(
    <WelcomeControls
      {...f}
      scope="scope"
      signal={new AbortController().signal}
      receipt={attempted}
      onSaved={() => {}}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Check and retry introduction" }),
  );
  await waitFor(() =>
    expect(readWelcome("scope")?.replyId).toBe("e".repeat(64)),
  );
  expect(f.agents.welcome).not.toHaveBeenCalled();
});

it("greets only after confirmed identity/default save, shows the next actions after a real reply, and never repeats on reopen", async () => {
  const f = fixture();
  const observed = {
    ...receipt,
    kickoff: "observed" as const,
    replyId: "c".repeat(64),
  };
  saveWelcome("scope", observed);
  let resolveGreeting!: (value: { id: string }) => void;
  const greeting = new Promise<{ id: string }>((resolve) => {
    resolveGreeting = resolve;
  });
  vi.mocked(f.agents.welcome).mockImplementation(
    async (_agent, _channel, _signal, phase) => {
      expect(phase).toBe("saved");
      expect(f.agents.find(agentKey)?.name).toBe("Ada");
      expect(readDefaultAgent("scope")).toBe(agentKey);
      expect(readWelcome("scope")).toMatchObject({
        complete: true,
        greeting: "attempted",
      });
      return greeting as ReturnType<Agents["welcome"]>;
    },
  );
  function Harness() {
    const { receipt: current } = useWelcomeReceipt("scope");
    return (
      current && (
        <WelcomeControls
          {...f}
          scope="scope"
          signal={signal}
          receipt={current}
          onSaved={() => {}}
        />
      )
    );
  }
  const signal = new AbortController().signal;
  const view = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  try {
    expect(f.agents.welcome).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Ada");
    await userEvent.click(screen.getByRole("button", { name: /Looks good/ }));
    await waitFor(() => expect(f.agents.welcome).toHaveBeenCalledOnce());
    expect(screen.getByText("Your agent is saying hello…")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Get started" })).toBeNull();
    resolveGreeting({ id: "d".repeat(64) });
    expect(
      await screen.findByRole("region", { name: "Get started" }),
    ).toBeVisible();
    for (const name of [
      "Tell me about Buzz",
      "Tell me about this community",
      "Finish setting up this agent",
    ])
      expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(readWelcome("scope")?.greetingId).toBe("d".repeat(64));
    view.unmount();
    render(<Harness />);
    expect(screen.getByRole("region", { name: "Get started" })).toBeVisible();
    expect(f.agents.welcome).toHaveBeenCalledOnce();
  } finally {
    resolveGreeting({ id: "d".repeat(64) });
  }
});

it("reconciles an uncertain saved greeting by its exact marker without mistaking the initial welcome or posting twice", async () => {
  const f = fixture();
  const attempted = {
    ...receipt,
    complete: true,
    kickoffAt: 100,
    greeting: "attempted" as const,
    greetingAt: 100,
  };
  saveWelcome("scope", attempted);
  vi.mocked(f.session.read).mockResolvedValue([
    {
      id: "b".repeat(64),
      kind: 9,
      pubkey: agentKey,
      content: "Initial welcome",
      created_at: 100,
      tags: [["h", channelId]],
    },
    {
      id: "d".repeat(64),
      kind: 9,
      pubkey: agentKey,
      content: "Saved greeting",
      created_at: 100,
      tags: [
        ["h", channelId],
        ["client-id", `welcome-saved:${channelId}`],
      ],
    },
  ]);
  render(
    <WelcomeNextSteps
      {...f}
      scope="scope"
      receipt={attempted}
      signal={new AbortController().signal}
    />,
  );
  expect(f.agents.welcome).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Check and retry greeting" }),
  );
  await waitFor(() =>
    expect(readWelcome("scope")?.greetingId).toBe("d".repeat(64)),
  );
  expect(f.agents.welcome).not.toHaveBeenCalled();
});

it("keeps the completed identity when greeting fails and leaves an explicit retry", async () => {
  const f = fixture();
  const saved = { ...receipt, complete: true, greeting: "pending" as const };
  saveWelcome("scope", saved);
  vi.mocked(f.agents.welcome).mockRejectedValueOnce(
    new Error("Provider unavailable"),
  );
  render(
    <WelcomeNextSteps
      {...f}
      scope="scope"
      receipt={saved}
      signal={new AbortController().signal}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Provider unavailable",
  );
  expect(readWelcome("scope")).toMatchObject({
    complete: true,
    greeting: "attempted",
  });
  expect(
    screen.getByRole("button", { name: "Check and retry greeting" }),
  ).toBeEnabled();
  expect(f.agents.save).not.toHaveBeenCalled();
});

it("does not use an ordinary agent reply as saved-greeting evidence", async () => {
  const f = fixture();
  const attempted = {
    ...receipt,
    complete: true,
    greeting: "attempted" as const,
    greetingAt: 100,
  };
  saveWelcome("scope", attempted);
  vi.mocked(f.session.read).mockResolvedValue([
    {
      id: "c".repeat(64),
      kind: 9,
      pubkey: agentKey,
      content: "Initial welcome",
      created_at: 100,
      tags: [["h", channelId]],
    },
  ]);
  vi.mocked(f.agents.welcome).mockRejectedValueOnce(
    new Error("Hosting unavailable"),
  );
  render(
    <WelcomeNextSteps
      {...f}
      scope="scope"
      receipt={attempted}
      signal={new AbortController().signal}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Check and retry greeting" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Hosting unavailable",
  );
  expect(f.agents.welcome).toHaveBeenCalledWith(
    agentKey,
    channelId,
    expect.any(AbortSignal),
    "saved",
  );
  expect(readWelcome("scope")?.greetingId).toBeUndefined();
  expect(screen.queryByRole("region", { name: "Get started" })).toBeNull();
});
