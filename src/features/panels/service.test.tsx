import { expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { PagesService } from "../pages/service";
import { PanelsService } from "../panels/service";
import { ConversationService } from "../conversation/service";
import { SettingsCardsService } from "../settings/service";
import { TemplateProvidersService } from "../channel-templates/provider";
import { provideAgentControl } from "../agents/control-service";
import { provideRelay } from "../relay/service";
import { provideNavigation } from "../navigation/service";
import * as channelsPlugin from "../../bundled/channels";
import * as githubPlugin from "../../bundled/github";
import { flush } from "../relay/testing";
import type { PluginInfo } from "../../plugins/types";

const plugin = (id: string): PluginInfo => ({
  manifest: { id, name: id, apiVersion: 1 },
  enabled: true,
  source: "bundled",
  revision: "one",
  previous: null,
  reloadable: false,
  error: null,
});
it("independently unloads panels without removing the page or shared data", async () => {
  const root = new Context();
  const runtime = new PluginRuntime(root, async (info) =>
    info.manifest.id === "channels" ? channelsPlugin : githubPlugin,
  );
  const pages = new PagesService(root),
    panels = new PanelsService(root);
  new ConversationService(root);
  new SettingsCardsService(root);
  new TemplateProvidersService(root);
  provideNavigation(root);
  provideAgentControl(root);
  const relay = provideRelay(root);
  const desired = (ids: string[]) => ids.map(plugin);
  try {
    runtime.reconcile(desired(["channels", "github"]));
    await flush();
    expect(pages.snapshot()).toHaveLength(1);
    expect(panels.resolve("https://github.com/block/buzz/pull/23")?.title).toBe(
      "GitHub",
    );
    const queries = relay.snapshot().session;
    runtime.reconcile(desired(["channels"]));
    await flush();
    expect(panels.snapshot()).toHaveLength(0);
    expect(pages.snapshot()).toHaveLength(1);
    expect(relay.snapshot().session).toBe(queries);
    runtime.reconcile(desired(["channels", "github"]));
    await flush();
    expect(panels.snapshot()).toHaveLength(1);
    runtime.reconcile(desired(["github"]));
    await flush();
    expect(pages.snapshot()).toHaveLength(0);
    expect(
      panels.resolve("https://github.com/block/buzz/pull/23"),
    ).toBeDefined();
    expect(relay.snapshot().session).toBe(queries);
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("skips faulty matchers, chooses the first match, and removes disposed contributions", async () => {
  const root = new Context();
  let active = false;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const panels = new PanelsService(root);
  const scope = root.extend({ pluginOwner: { id: "test", revision: "one" } });
  const fiber = scope.plugin((ctx) => {
    ctx.panels.register({
      id: "broken",
      title: "Broken",
      matches: () => {
        throw new Error("bad matcher");
      },
      component: () => null,
    });
    ctx.panels.register({
      id: "first",
      title: "First",
      matches: (target) => target.startsWith("buzz:"),
      component: () => null,
    });
    ctx.panels.register({
      id: "second",
      title: "Second",
      matches: () => true,
      component: () => null,
    });
  });
  await fiber.await();
  expect(panels.resolve("buzz:object")).toBeUndefined();
  active = true;
  for (const listener of listeners) listener();
  expect(panels.resolve("buzz:object")?.id).toBe("first");
  await fiber.dispose();
  expect(panels.resolve("buzz:object")).toBeUndefined();
  await root.fiber.dispose();
});

it("validates and freezes launcher metadata without changing target resolution", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(root);
  const scope = root.extend({
    pluginOwner: { id: "launchers", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    const base = {
      id: "notes",
      title: "Notes",
      matches: () => false,
      component: () => null,
    };
    for (const launcher of [
      null,
      {},
      { icon: "", target: "" },
      { icon: "/icon.png", target: 1 },
    ]) {
      expect(() => ctx.panels.register({ ...base, launcher } as never)).toThrow(
        "launcher",
      );
    }
    for (const channelPlacement of [null, "left", "", 42, {}]) {
      expect(() =>
        ctx.panels.register({ ...base, channelPlacement } as never),
      ).toThrow("placement");
    }
    for (const channelMenu of [
      null,
      {},
      { label: "", eligible: () => true },
      { label: "Usage", eligible: true },
    ]) {
      expect(() =>
        ctx.panels.register({ ...base, channelMenu } as never),
      ).toThrow("channel menu");
    }
    const launcher = { icon: "/icon.png", target: "" };
    const channelMenu = { label: "Usage", eligible: () => true };
    ctx.panels.register({ ...base, launcher, channelMenu });
    launcher.icon = "/mutated.png";
    channelMenu.label = "mutated";
  });
  await fiber.await();
  expect(panels.snapshot()[0]?.launcher).toEqual({
    icon: "/icon.png",
    target: "",
  });
  expect(Object.isFrozen(panels.snapshot()[0]?.launcher)).toBe(true);
  expect(panels.snapshot()[0]?.channelMenu?.label).toBe("Usage");
  expect(Object.isFrozen(panels.snapshot()[0]?.channelMenu)).toBe(true);
  expect(panels.resolve("")).toBeUndefined();
  await fiber.dispose();
  expect(panels.snapshot()).toEqual([]);
  await root.fiber.dispose();
});
