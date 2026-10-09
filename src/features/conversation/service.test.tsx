import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "./service";
import { inlineMatches } from "./InlineText";
import type { PluginModule } from "../../plugins/api";
import type { ChannelMessage } from "../relay/contracts";
import type { InlineRenderer } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import * as emoji from "../../bundled/emoji";
import * as mentions from "../../bundled/mentions";
import * as links from "../../bundled/links";

const Component = () => null;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});
function harness(module: PluginModule) {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => module);
  const service = new ConversationService(root);
  cleanups.push(async () => {
    await runtime.dispose();
    await root.fiber.dispose();
  });
  const plugin = {
    manifest: { id: "test.tools", name: "Tools", apiVersion: 1 as const },
    enabled: true,
    source: "external" as const,
    revision: "one",
    previous: null,
    reloadable: true,
    error: null,
  };
  return { service, runtime, plugin };
}
it("registers both surfaces under the injecting plugin scope, removes and replaces exact instances", async () => {
  const h = harness({
    inject: ["conversation"],
    apply(ctx) {
      const conversation = ctx.conversation;
      expect(conversation.ui.Composer).toBe(conversation.ui.Composer);
      expect(conversation.ui.Message).toBe(conversation.ui.Message);
      expect(conversation.ui.Thread).toBe(conversation.ui.Thread);
      const now = new Date(2026, 9, 2, 14, 30).getTime() / 1000;
      expect(conversation.format.dayGroupLabel(now, now)).toBe("Today");
      expect(
        conversation.format.itemTimestamp(now - 86_400, {
          withTime: true,
          nowSeconds: now,
        }),
      ).toBe("Yesterday at 2:30 PM");
      expect(conversation.format.relativeTimestamp(now - 300, now)).toBe(
        "5 minutes ago",
      );
      expect(conversation.format.fullTimestamp(now)).toBe(
        new Date(now * 1000).toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long",
        }),
      );
      ctx.conversation.registerTool({
        id: "tool",
        title: "Tool",
        component: Component,
      });
      ctx.conversation.registerInline({
        id: "inline",
        title: "Inline",
        component: Component,
        matches: () => [],
      });
    },
  });
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() => expect(h.service.tools.snapshot()).toHaveLength(1));
  const first = h.service.tools.snapshot()[0];
  expect(first?.pluginId).toBe(h.plugin.manifest.id);
  expect(h.service.inline.snapshot()).toHaveLength(1);
  h.runtime.reconcile([]);
  await vi.waitFor(() => expect(h.service.tools.snapshot()).toHaveLength(0));
  expect(h.service.inline.snapshot()).toHaveLength(0);
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() => expect(h.service.tools.snapshot()).toHaveLength(1));
  expect(h.service.tools.snapshot()[0]).not.toBe(first);
});
it("bundled Emoji really registers a picker and a renderer, including reaction metadata", async () => {
  const h = harness(emoji);
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() => expect(h.service.tools.snapshot()).toHaveLength(1));
  const custom = { shortcode: "party", url: "https://a.test/body" };
  const row: ChannelMessage = {
    id: "row",
    channelId: "c",
    authorId: "a",
    createdAt: 1,
    content: ":party:",
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    emoji: [custom],
  };
  const content = { text: ":party:", message: row };
  expect(inlineMatches(content, h.service.inline.snapshot())).toHaveLength(1);
  expect(
    inlineMatches(
      { ...content, reaction: { content: ":party:", events: [] } },
      h.service.inline.snapshot(),
    ),
  ).toHaveLength(0);
  expect(
    inlineMatches(
      {
        ...content,
        reaction: { content: ":party:", emoji: custom, events: [] },
      },
      h.service.inline.snapshot(),
    ),
  ).toHaveLength(1);
});
it("waits for successful activation and rolls back both surfaces on apply failure", async () => {
  const h = harness({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerTool({
        id: "tool",
        title: "Tool",
        component: Component,
      });
      throw new Error("broken activation");
    },
  });
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() =>
    expect(h.runtime.snapshot()[h.plugin.manifest.id]?.status).toBe("failed"),
  );
  expect(h.service.tools.snapshot()).toHaveLength(0);
});
it("validates ranges, skips failures, and deterministically resolves overlap", () => {
  const renderers = [
    () => {
      throw new Error("bad matcher");
    },
    () => [
      { start: -1, end: 2 },
      { start: 1, end: 3 },
      { start: 2, end: 100 },
      { start: 3, end: 3 },
    ],
    () => [
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ],
  ].map(
    (matches, i) =>
      ({
        key: `${i}`,
        pluginId: `${i}`,
        revision: "one",
        id: `${i}`,
        title: "test",
        component: Component,
        matches,
      }) satisfies Contribution<InlineRenderer>,
  );
  expect(
    inlineMatches(
      { text: "test", message: {} as ChannelMessage },
      renderers,
    ).map(({ start, end }) => [start, end]),
  ).toEqual([
    [1, 3],
    [3, 4],
  ]);
});

it("bundled Mentions registers only a chooser and removal leaves the host UI available", async () => {
  const h = harness(mentions);
  const composer = h.service.ui.Composer;
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() => expect(h.service.tools.snapshot()).toHaveLength(1));
  expect(h.service.tools.snapshot()[0]?.title).toBe("Mentions");
  expect(h.service.inline.snapshot()).toHaveLength(0);
  h.runtime.reconcile([]);
  await vi.waitFor(() => expect(h.service.tools.snapshot()).toHaveLength(0));
  expect(h.service.ui.Composer).toBe(composer);
});

it("bundled Links registers, withdraws, and restores a fresh renderer", async () => {
  const h = harness(links);
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() => expect(h.service.links.snapshot()).toHaveLength(1));
  const first = h.service.links.snapshot()[0];
  expect(first?.matches("https://github.com/block/buzz")).toBe(true);
  expect(first?.matches("javascript:alert(1)")).toBe(false);
  h.runtime.reconcile([]);
  await vi.waitFor(() => expect(h.service.links.snapshot()).toHaveLength(0));
  h.runtime.reconcile([{ ...h.plugin, revision: "two" }]);
  await vi.waitFor(() => expect(h.service.links.snapshot()).toHaveLength(1));
  expect(h.service.links.snapshot()[0]).not.toBe(first);
  expect(h.service.links.snapshot()[0]?.revision).toBe("two");
});

it("rejects a link renderer order that is neither a number nor a function", async () => {
  const h = harness({
    inject: ["conversation"],
    apply(ctx) {
      const base = { id: "link", title: "Link", matches: () => true };
      for (const order of [null, "100", {}, true]) {
        expect(() =>
          ctx.conversation.registerLink({
            ...base,
            order,
            component: Component,
          } as never),
        ).toThrow("order");
      }
      ctx.conversation.registerLink({
        ...base,
        order: (url) => (url.startsWith("https://") ? 100 : 0),
        component: Component,
      });
    },
  });
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() => expect(h.service.links.snapshot()).toHaveLength(1));
  expect(h.runtime.snapshot()[h.plugin.manifest.id]?.status).toBe("active");
});

it("withdraws link presentation when plugin activation fails", async () => {
  const h = harness({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerLink({
        id: "link",
        title: "Link",
        matches: () => true,
        component: Component,
      });
      throw new Error("failed link plugin");
    },
  });
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() =>
    expect(h.runtime.snapshot()[h.plugin.manifest.id]?.status).toBe("failed"),
  );
  expect(h.service.links.snapshot()).toHaveLength(0);
});

it("owns completion registration through disable, replacement and failed activation", async () => {
  const h = harness({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerCompletion({
        id: "completion",
        title: "Completion",
        match: () => null,
        component: Component,
      });
    },
  });
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() =>
    expect(h.service.completions.snapshot()).toHaveLength(1),
  );
  const first = h.service.completions.snapshot()[0];
  h.runtime.reconcile([]);
  await vi.waitFor(() =>
    expect(h.service.completions.snapshot()).toHaveLength(0),
  );
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() =>
    expect(h.service.completions.snapshot()).toHaveLength(1),
  );
  expect(h.service.completions.snapshot()[0]).not.toBe(first);
  const broken = harness({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerCompletion({
        id: "completion",
        title: "Completion",
        match: () => null,
        component: Component,
      });
      throw new Error("failure after registration");
    },
  });
  broken.runtime.reconcile([broken.plugin]);
  await vi.waitFor(() =>
    expect(broken.runtime.snapshot()[broken.plugin.manifest.id]?.status).toBe(
      "failed",
    ),
  );
  expect(broken.service.completions.snapshot()).toHaveLength(0);
});
it.each([emoji, mentions])(
  "bundled plugin registers its own completion provider",
  async (module) => {
    const h = harness(module);
    h.runtime.reconcile([h.plugin]);
    await vi.waitFor(() =>
      expect(h.service.completions.snapshot()).toHaveLength(1),
    );
    expect(h.service.completions.snapshot()[0]?.pluginId).toBe(
      h.plugin.manifest.id,
    );
  },
);

it("owns accessories through disable, replacement and failed activation", async () => {
  const h = harness({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerAccessory({
        id: "status",
        title: "Status",
        component: Component,
      });
    },
  });
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() =>
    expect(h.service.accessories.snapshot()).toHaveLength(1),
  );
  const first = h.service.accessories.snapshot()[0];
  h.runtime.reconcile([]);
  await vi.waitFor(() =>
    expect(h.service.accessories.snapshot()).toHaveLength(0),
  );
  h.runtime.reconcile([h.plugin]);
  await vi.waitFor(() =>
    expect(h.service.accessories.snapshot()).toHaveLength(1),
  );
  expect(h.service.accessories.snapshot()[0]).not.toBe(first);
  const broken = harness({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerAccessory({
        id: "status",
        title: "Status",
        component: Component,
      });
      throw new Error("failed after registration");
    },
  });
  broken.runtime.reconcile([broken.plugin]);
  await vi.waitFor(() =>
    expect(broken.runtime.snapshot()[broken.plugin.manifest.id]?.status).toBe(
      "failed",
    ),
  );
  expect(broken.service.accessories.snapshot()).toHaveLength(0);
});
