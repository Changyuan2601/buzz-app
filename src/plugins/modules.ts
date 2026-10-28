import type { PluginModule } from "./api";
import type { PluginInfo } from "./types";
import type { PluginStorage } from "./storage";

// A bundled plugin is its evaluated module, or a loader for a code-split one.
export type BundledModule = PluginModule | (() => Promise<PluginModule>);

// Internal activation helper. Re-enabling a revision reuses its evaluated module.
// Browser ESM modules cannot be evicted; restarting releases previously loaded revisions.
export function createModuleLoader(
  bundled: Record<string, BundledModule>,
  readModule: PluginStorage["readModule"],
) {
  const modules = new Map<string, Promise<PluginModule>>();
  function loadModule(plugin: PluginInfo): Promise<PluginModule> {
    const key = `${plugin.manifest.id}:${plugin.revision}`;
    const cached = modules.get(key);
    if (cached) return cached;
    const promise = (async () => {
      let module: unknown;
      if (plugin.source === "bundled") {
        const entry = bundled[plugin.manifest.id];
        module = typeof entry === "function" ? await entry() : entry;
      } else {
        const code = await readModule(plugin.manifest.id, plugin.revision);
        const url = URL.createObjectURL(
          new Blob([code], { type: "text/javascript" }),
        );
        try {
          module = await import(/* @vite-ignore */ url);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!module || typeof module !== "object")
        throw new Error("Invalid plugin module");
      if ("apply" in module && typeof module.apply === "function")
        return module as PluginModule;
      throw new Error("Plugin must export apply(ctx)");
    })();
    modules.set(key, promise);
    void promise.catch(() => {
      modules.delete(key);
    });
    return promise;
  }

  return loadModule;
}
