import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { ArtifactStorageService } from "./service";

it("binds collection ownership to the calling plugin and fences scope changes", async () => {
  const root = new Context();
  let scope = { viewer: "viewer", selected: "https://relay.test" };
  const subscribers = new Set<() => void>();
  root.provide("communityReader", {
    snapshot: () => scope,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  });
  const service = new ArtifactStorageService(root);
  const plugin = root.extend({
    pluginOwner: { id: "test.plugin", revision: "one" },
  });
  const definition = {
    name: "tasks",
    type: "test.task",
    version: 1,
    project: () => [],
  };
  expect(() => root.artifactStorage.open(definition)).toThrow("needs a plugin");
  // Storage is the external boundary here; browser tests exercise its real transactions.
  const get = vi.fn(async () => undefined);
  const close = vi.fn();
  const collection = { get, close };
  const factory = vi.fn(() => collection);
  const stores = service as unknown as { stores: Map<string, unknown> };
  stores.stores.set(JSON.stringify(["viewer", "https://relay.test"]), {
    collection: factory,
    close: vi.fn(),
  });
  const listener = vi.fn();
  service.onOpen(listener);
  const handle = plugin.artifactStorage.open(definition);
  expect(factory).toHaveBeenCalledWith("test.plugin", definition);
  expect(listener.mock.calls[0]?.[0]).toMatchObject({
    owner: "test.plugin",
    viewer: "viewer",
    relay: "https://relay.test",
    collection,
  });
  expect(handle).not.toHaveProperty("applyBatch");
  await handle.get("task");
  expect(get).toHaveBeenCalledWith("task");
  scope = { viewer: "other", selected: "https://relay.test" };
  for (const listener of subscribers) listener();
  expect(listener.mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(close).toHaveBeenCalled();
  expect(() => handle.get("task")).toThrow("scope changed");
  await root.fiber.dispose();
});
