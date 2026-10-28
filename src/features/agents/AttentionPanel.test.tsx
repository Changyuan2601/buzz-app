// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { describeWatch } from "./attention";
import { AttentionPanel } from "./AttentionPanel";
import type { Agent } from "./service";

afterEach(cleanup);

const agent: Agent = {
  key: "a".repeat(64),
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

it("keeps the device runtime control and directs watch management to Agent Attention", async () => {
  const save = vi.fn(async () => {});
  render(<AttentionPanel agent={agent} save={save} />);
  expect(
    screen.getByText(/Manage Interests and watches in Agent Attention/),
  ).toBeInTheDocument();
  expect(screen.queryByText("Keep releases moving.")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("switch", { name: "Attention on this device" }));
  expect(save).toHaveBeenCalledWith({ attentionEnabled: false });
});

it("keeps failed runtime changes visible for retry", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Save failed"))
    .mockResolvedValue(undefined);
  render(<AttentionPanel agent={agent} save={save} />);
  const user = userEvent.setup();
  const toggle = screen.getByRole("switch", {
    name: "Attention on this device",
  });
  await user.click(toggle);
  expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
