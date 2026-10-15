import react from "@vitejs/plugin-react";
import {
  createServer as createViteServer,
  optimizeDeps,
  resolveConfig,
} from "vite";
import { constants } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const seedVariable = "BUZZ_FIXTURE_VITE_DEPS";
// Every fixture page is in this scan. Add a dependency here only when a test
// imports it outside these pages, for example from page.evaluate.
const fixtureOptimizeDeps = {
  entries: ["index.html", "tests/**/*.html"],
  include: ["@jsquash/webp/encode.js"],
};
// Fixture plugins may only add server middleware or rewrite index HTML. Neither
// changes optimized dependencies, so they all run as one stable plugin.
const fixtureHooks = new Set(["name", "configureServer", "transformIndexHtml"]);

// Vite reuses a dependency cache only when its config hash matches. Fixtures
// leave the other hashed settings at their defaults; fixing the root, plugin
// names and optimizeDeps lets every fixture server reuse one prepared cache.
function fixtureConfig({ plugins = [], optimizeDeps: custom, ...config }) {
  if (custom)
    throw new Error(
      "Fixture servers share one dependency optimizer; add dependencies to fixtureOptimizeDeps in vite-server.mjs",
    );
  if (config.root !== undefined && resolve(config.root) !== resolve(root))
    throw new Error(
      `Fixture servers serve the repository root, not ${config.root}`,
    );
  const flat = plugins.flat(Infinity).filter(Boolean);
  const isReact = (plugin) => plugin.name.startsWith("vite:react");
  const framework = flat.filter(isReact);
  return {
    ...config,
    root,
    plugins: [
      ...(framework.length ? framework : react()),
      fixturePlugin(flat.filter((plugin) => !isReact(plugin))),
    ],
    optimizeDeps: fixtureOptimizeDeps,
  };
}

function fixturePlugin(plugins) {
  for (const plugin of plugins)
    for (const [key, value] of Object.entries(plugin))
      if (
        !fixtureHooks.has(key) ||
        (key !== "name" && typeof value !== "function")
      )
        throw new Error(
          `Fixture plugin ${plugin.name} uses ${key}; fixture plugins may only define configureServer and transformIndexHtml functions`,
        );
  return {
    name: "buzz-fixture-server",
    async configureServer(server) {
      const after = [];
      for (const plugin of plugins) {
        const result = await plugin.configureServer?.(server);
        if (typeof result === "function") after.push(result);
      }
      return async () => {
        for (const run of after) await run();
      };
    },
    async transformIndexHtml(html, context) {
      for (const plugin of plugins) {
        if (!plugin.transformIndexHtml) continue;
        html = await plugin.transformIndexHtml(html, context);
        if (typeof html !== "string")
          throw new Error(`Fixture plugin ${plugin.name} must return HTML`);
      }
      return html;
    },
  };
}

// Run once per test run, before any test: it scans and bundles the fixture
// dependencies so no server does that work inside a navigation budget.
export async function prepareFixtureDependencies() {
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-fixture-vite-deps-"));
  // Resolving a serve config sets NODE_ENV=development when it is unset.
  // Workers inherit the runner's environment, so a leaked value would make
  // their production app builds report import.meta.env.DEV as true.
  const nodeEnv = process.env.NODE_ENV;
  try {
    const config = await resolveConfig(
      {
        ...fixtureConfig({ configFile: false, envDir: false }),
        cacheDir,
        logLevel: "error",
      },
      "serve",
    );
    await optimizeDeps(config);
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  process.env[seedVariable] = cacheDir;
  return async () => {
    delete process.env[seedVariable];
    await rm(cacheDir, { recursive: true, force: true });
  };
}

// Playwright's globalSetup.
export default prepareFixtureDependencies;

// Parallel fixture servers must not invalidate each other's optimized imports,
// so each one gets its own copy of the prepared cache.
export async function createServer(config) {
  const seed = process.env[seedVariable];
  if (!seed && process.env.TEST_WORKER_INDEX !== undefined)
    throw new Error(
      "Fixture dependencies are not prepared; run the browser tests through playwright.config.mjs",
    );
  const fixture = fixtureConfig(config);
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-fixture-vite-"));
  try {
    if (seed)
      await cp(seed, cacheDir, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    const server = await createViteServer({ ...fixture, cacheDir });
    const close = server.close.bind(server);
    server.close = async () => {
      try {
        await close();
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    };
    return server;
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
