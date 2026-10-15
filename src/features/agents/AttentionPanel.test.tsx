// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { describeWatch } from "./attention";
import { compileFilter } from "./attention";
import type { RelaySession } from "../relay/session";
import { AttentionPanel } from "./AttentionPanel";
import type { Agent, AgentChange } from "./service";

afterEach(cleanup);

const agent: Agent = {
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
  attention: {
    "interest/release-triage": {
      slug: "interest/release-triage",
      modifiedAt: 1,
      value: { type: "interest", instructions: "Keep releases moving." },
    },
    "watch/questions": {
      slug: "watch/questions",
      modifiedAt: 1,
      value: {
        type: "event",
        interest_id: "release-triage",
        enabled: true,
        since: 1,
        channels: ["c1"],
        kinds: [9],
      },
    },
  },
};

it("creates a selected-sender topic watch without JSON and ignores unrelated text", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async (_change: AgentChange) => {});
  const sender = "b".repeat(64);
  const available = {
    pubkey: sender,
    name: "Old Moonpal",
    managedName: "Moonpal",
    managed: true,
  };
  const choices = {
    identities: [available],
    selectable: [available],
    pending: false,
    complete: false,
    archives: { status: "ready", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      ensure: vi.fn(),
      retain: () => () => {},
    },
  } as unknown as RelaySession;
  render(<AttentionPanel agent={agent} save={save} session={session} />);
  await user.click(screen.getByRole("button", { name: "Add watch" }));
  await user.click(screen.getByRole("combobox", { name: "From" }));
  await user.click(await screen.findByRole("option", { name: "Moonpal" }));
  await user.type(
    screen.getByLabelText("Contains any word (optional)"),
    "MUD, MUDs",
  );
  await user.click(screen.getByRole("button", { name: "Add watch" }));
  expect(save).toHaveBeenCalledOnce();
  const watch = save.mock.calls[0]?.[0].attention?.["watch/messages"];
  if (watch?.type !== "event" || !watch.filter)
    throw new Error("Missing saved watch");
  const filter = compileFilter(watch.filter);
  expect(filter.author).toBe(sender);
  const event = {
    pubkey: sender,
    content: "a mud game",
    id: "x",
    kind: 9,
    created_at: 1,
    tags: [],
  };
  expect(filter(event)).toBe(true);
  expect(filter({ ...event, content: "what is going on @Palmer?" })).toBe(
    false,
  );
  expect(filter({ ...event, pubkey: agent.owner })).toBe(false);
});

it("names watches by what and where they wake", () => {
  const watch = agent.attention["watch/questions"]?.value;
  if (watch?.type !== "event") throw new Error("fixture");
  expect(describeWatch(watch, [{ id: "c1", name: "releases" }])).toBe(
    "Messages in #releases",
  );
  expect(describeWatch(watch)).toBe("Messages in 1 channel");
  expect(describeWatch({ ...watch, channels: "all", kinds: [] })).toBe(
    "Any event in any channel",
  );
});

it("groups watches under their interest, pauses them, and adds timers", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(
    <AttentionPanel
      agent={agent}
      save={save}
      channels={[{ id: "c1", name: "releases" }]}
    />,
  );
  const group = screen.getByRole("region", { name: "Release triage" });
  expect(within(group).getByText("Keep releases moving.")).toBeInTheDocument();

  await user.click(
    within(group).getByRole("switch", { name: "Messages in #releases on" }),
  );
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/questions": expect.objectContaining({ enabled: false }),
    },
  });

  await user.click(within(group).getByRole("button", { name: "Add timer" }));
  await user.type(screen.getByLabelText("Prompt"), "Summarise blockers");
  await user.click(screen.getByRole("button", { name: "Add timer" }));
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/timer": expect.objectContaining({
        type: "timer",
        interest_id: "release-triage",
        prompt: "Summarise blockers",
        interval_secs: 3600,
      }),
    },
  });
});

it("lets the owner turn the agent's attention off", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(<AttentionPanel agent={agent} save={save} channels={[]} />);
  const toggle = screen.getByRole("switch", { name: "Attention on" });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(save).toHaveBeenLastCalledWith({ attentionEnabled: false });
});

it("accepts the curly quotes macOS substitutes in a watch filter", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(<AttentionPanel agent={agent} save={save} channels={[]} />);
  const group = screen.getByRole("region", { name: "Release triage" });
  await user.click(within(group).getByRole("button", { name: "Add watch" }));
  await user.click(screen.getByText("Advanced filter"));
  await user.type(
    screen.getByLabelText("Filter expression (optional)"),
    "content == \u201Csecretpassword\u201D",
  );
  await user.click(screen.getByRole("button", { name: "Add watch" }));
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/messages": expect.objectContaining({
        filter: 'content == "secretpassword"',
      }),
    },
  });
});

it("builds a filter from the simple fields and the advanced expression", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(<AttentionPanel agent={agent} save={save} channels={[]} />);
  const group = screen.getByRole("region", { name: "Release triage" });
  await user.click(within(group).getByRole("button", { name: "Add watch" }));
  await user.type(screen.getByLabelText("Text is exactly (optional)"), "ship");
  await user.click(screen.getByText("Advanced filter"));
  await user.type(
    screen.getByLabelText("Filter expression (optional)"),
    'author == "a" || author == "b"',
  );
  await user.click(screen.getByRole("button", { name: "Add watch" }));
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/messages": expect.objectContaining({
        filter: 'content == "ship" && (author == "a" || author == "b")',
      }),
    },
  });
});

it("keeps an Interest in use, shows skipped objects, and rearms a spent timer", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  const timer = {
    type: "timer",
    interest_id: "release-triage",
    prompt: "Summarise blockers",
    enabled: true,
    interval_secs: 60,
    armed_at: 100,
    max_occurrences: 1,
    expires_at: null,
  } as const;
  render(
    <AttentionPanel
      agent={{
        ...agent,
        attention: {
          ...agent.attention,
          "watch/timer": { slug: "watch/timer", modifiedAt: 1, value: timer },
        },
        timers: { "watch/timer": { armedAt: 100, nextDue: 220, used: 1 } },
        skipped: {
          "watch/bad": {
            slug: "watch/bad",
            value: { type: "event" },
            modifiedAt: 1,
            problem: "Missing field: interest_id",
          },
        },
      }}
      save={save}
      channels={[]}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Actions for Release triage" }),
  );
  expect(
    await screen.findByRole("menuitem", {
      name: "Remove (first remove what uses it)",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");

  const skipped = screen.getByRole("region", { name: "Skipped" });
  expect(
    within(skipped).getByText("Missing field: interest_id"),
  ).toBeInTheDocument();

  expect(screen.getByText(/Done, ran 1 of 1 time/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Actions for Every/ }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit JSON" }));
  expect(
    screen.getByText(/A changed interval_secs starts after the next run\./),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: /^Actions for Every/ }));
  await user.click(await screen.findByRole("menuitem", { name: "Run again" }));
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "watch/timer": expect.objectContaining({
        enabled: true,
        armed_at: expect.any(Number),
      }),
    },
    restart: ["watch/timer"],
  });
  const [change] = save.mock.lastCall as unknown as [
    { attention: Record<string, { armed_at: number }> },
  ];
  expect(change.attention["watch/timer"]?.armed_at).toBeGreaterThan(100);
});

it("never names a new object after a skipped one it would replace", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  render(
    <AttentionPanel
      agent={{
        ...agent,
        skipped: {
          "watch/messages": {
            slug: "watch/messages",
            value: { type: "event" },
            modifiedAt: 1,
            problem: "Missing field: interest_id",
          },
        },
      }}
      save={save}
      channels={[]}
    />,
  );
  const group = screen.getByRole("region", { name: "Release triage" });
  await user.click(within(group).getByRole("button", { name: "Add watch" }));
  await user.click(screen.getByRole("button", { name: "Add watch" }));
  expect(save).toHaveBeenLastCalledWith({
    attention: { "watch/messages-2": expect.any(Object) },
  });
});

it("adds an interest in a modal and retains the draft after a save error", async () => {
  const user = userEvent.setup();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Try again"))
    .mockResolvedValue(undefined);
  render(<AttentionPanel agent={agent} save={save} channels={[]} />);
  await user.click(screen.getByRole("button", { name: "Add interest" }));
  const dialog = screen.getByRole("dialog", { name: "Add interest" });
  await user.type(within(dialog).getByLabelText("Interest name"), "Releases");
  await user.type(
    within(dialog).getByPlaceholderText(
      "What should the agent do for this task?",
    ),
    "Track releases.",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Add interest" }),
  );
  expect(await within(dialog).findByText("Try again")).toBeVisible();
  expect(within(dialog).getByLabelText("Interest name")).toHaveValue(
    "Releases",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Add interest" }),
  );
  expect(save).toHaveBeenLastCalledWith({
    attention: {
      "interest/releases": {
        type: "interest",
        instructions: "Track releases.",
      },
    },
  });
});

it.each(["cancel", "escape", "save"])(
  "restores Add interest focus after %s",
  async (way) => {
    const user = userEvent.setup();
    render(<AttentionPanel agent={agent} save={vi.fn(async () => {})} />);
    await user.click(screen.getByRole("button", { name: "Add interest" }));
    const dialog = await screen.findByRole("dialog", { name: "Add interest" });
    if (way === "cancel")
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    else if (way === "escape") await user.keyboard("{Escape}");
    else {
      await user.type(
        within(dialog).getByLabelText("Interest name"),
        "New topic",
      );
      await user.type(
        within(dialog).getByLabelText("Instructions"),
        "Watch updates.",
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Add interest" }),
      );
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add interest" }),
      ).toHaveFocus(),
    );
  },
);
