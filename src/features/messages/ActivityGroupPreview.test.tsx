// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createAgentActivity } from "../agents/activity";
import { createLocalAgentActivity } from "../agents/local-activity";
import { createRelaySession } from "../relay/session";
import { keypair } from "../relay/testing";
import type { ChannelMessage } from "../relay/contracts";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import {
  activityPresentation,
  useActivityPresentation,
} from "./activity-presentation";
import { MessageRow } from "./MessageRow";

stubAvatarBrowserApis();
afterEach(cleanup);
const step: ChannelMessage = {
  id: "step",
  channelId: "channel",
  threadRootId: "request",
  authorId: "agent",
  audience: "agents",
  createdAt: 100,
  content: "Checking the layout",
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};
function fixture() {
  const local = createLocalAgentActivity();
  const activity = createAgentActivity(
    true,
    () => {},
    () => true,
    undefined,
    undefined,
    { source: local.reader, scope: "test" },
  );
  const release = activity.queries.activate();
  return {
    local,
    activity: activity.queries,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}
it("keeps a closed sequence completed when another request starts in the same thread", () => {
  const f = fixture();
  try {
    const { audience: _audience, ...publicStep } = step;
    function Preview() {
      const presentation = useActivityPresentation(
        [
          { ...step, id: "first" },
          step,
          {
            ...publicStep,
            id: "reply",
            content: "Result",
            createdAt: 101,
          },
        ],
        f.activity,
        new Set(["agent"]),
        "request",
      );
      const group = presentation.groups[0];
      if (!group) throw new Error("Missing activity group");
      return (
        <ActivityGroupPreview
          group={group}
          profiles={new Map()}
          media={() => undefined}
          expanded={false}
          onToggle={() => {}}
        />
      );
    }
    render(<Preview />);
    expect(screen.getByText("2 completed steps")).toBeVisible();
    act(() => {
      f.local
        .begin({
          scope: "test",
          agent: "agent",
          channelId: "channel",
          messageId: "next-request",
          threadRootId: "request",
        })
        .started();
    });
    expect(screen.getByText("2 completed steps")).toBeVisible();
    expect(screen.getByText("2 completed steps")).not.toHaveAttribute(
      "data-active",
    );
  } finally {
    f.dispose();
  }
});
it("shimmers a standalone working step and stops when that request finishes", () => {
  const f = fixture();
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  try {
    const work = f.local.begin({
      scope: "test",
      agent: "agent",
      channelId: "channel",
      messageId: "request",
      threadRootId: "request",
    });
    work.started();
    render(
      <MessageRow
        row={step}
        session={{ ...owner.session, agentActivity: f.activity }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(screen.getByText(step.content)).toHaveAttribute(
      "data-active",
      "true",
    );
    act(() => work.finish({ ok: true }));
    expect(screen.getByText(step.content)).not.toHaveAttribute("data-active");
  } finally {
    owner.dispose();
    f.dispose();
  }
});

it("keeps the primary avatar on the activity bubble without repeating an anchored byline", () => {
  const history = [{ ...step, id: "one" }, step];
  const renderGroup = (rows: ChannelMessage[]) => {
    const group = activityPresentation(rows, undefined, new Set(["agent"]))
      .groups[0];
    if (!group) throw new Error("Missing group");
    return (
      <ActivityGroupPreview
        group={group}
        profiles={new Map([["agent", { name: "Studio assistant" }]])}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />
    );
  };
  const view = render(renderGroup(history));
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  expect(screen.getByText("Studio assistant", { exact: true })).toBeVisible();
  const { audience: _, ...reply } = step;
  view.rerender(renderGroup([{ ...reply, id: "reply" }, ...history]));
  expect(screen.queryByText("Studio assistant", { exact: true })).toBeNull();
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  view.rerender(
    renderGroup([
      { ...reply, id: "reply" },
      { ...step, id: "one" },
      { ...step, authorId: "helper" },
    ]),
  );
  expect(screen.getByRole("img", { name: "Studio assistant" })).toBeVisible();
  view.rerender(
    renderGroup([
      { ...reply, id: "reply" },
      { ...reply, id: "user", authorId: "human" },
      ...history,
    ]),
  );
  expect(screen.getByText("Studio assistant", { exact: true })).toBeVisible();
});
