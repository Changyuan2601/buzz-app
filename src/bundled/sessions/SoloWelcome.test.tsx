// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SoloWelcome, WelcomeControls } from "./SoloWelcome";
import { AgentsContext } from "../../features/agents/react";
import {
  saveWelcome,
  readWelcome,
  defaultAssistant,
} from "../../features/sessions/welcome";
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

it("shows registered providers as honest placeholders without invoking their setup or creation", async () => {
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
    ...["Codex", "Goose", "Builderlab"].map((title) => ({
      ...placeholder,
      key: `test/${title.toLowerCase()}`,
      title,
      provider: { ...provider, check: placeholderCheck },
    })),
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
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
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
  for (const title of ["Codex", "Goose", "Builderlab"]) {
    const button = screen.getByRole("button", { name: `Connect ${title}` });
    expect(button).toBeDisabled();
    await userEvent.click(button);
  }
  expect(placeholderCheck).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.agents.welcome).not.toHaveBeenCalled();
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
  expect(defaultAssistant("scope")).toBe(agentKey);
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
  expect(defaultAssistant("scope")).toBe("");
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
  expect(defaultAssistant("scope")).toBe("");
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
