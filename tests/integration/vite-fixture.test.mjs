import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  createServer,
  prepareFixtureDependencies,
} from "../browser/vite-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = {
  configFile: false,
  envDir: false,
  logLevel: "silent",
  server: { middlewareMode: true, ws: false, watch: null },
};
let release, seed, nodeEnvBefore, nodeEnvAfter;
before(async () => {
  nodeEnvBefore = process.env.NODE_ENV;
  release = await prepareFixtureDependencies();
  nodeEnvAfter = process.env.NODE_ENV;
  seed = process.env.BUZZ_FIXTURE_VITE_DEPS;
});
after(() => release?.());

test("preparing dependencies leaves NODE_ENV for production app builds", () => {
  // Workers inherit the runner's environment; a leaked "development" turns
  // import.meta.env.DEV on in the built app.
  assert.equal(nodeEnvAfter, nodeEnvBefore);
});

test("differently configured fixture servers start from the prepared dependencies", async () => {
  // Vite deletes the deps directory before it optimizes again.
  const marker = join(seed, "deps", "prepared-marker.js");
  await writeFile(marker, "export default 1;");
  const servers = [];
  try {
    for (const variant of [
      {},
      { plugins: [{ name: "middleware", configureServer() {} }] },
      {
        define: { "import.meta.env.VITE_BUZZ_LIVE": '"0"' },
        plugins: [{ name: "html", transformIndexHtml: (html) => html }],
      },
    ]) {
      const server = await createServer({ ...config, ...variant });
      servers.push(server);
      const optimizer = server.environments.client.depsOptimizer;
      await optimizer.init();
      assert.ok(optimizer.metadata.optimized.react);
      assert.notEqual(server.config.cacheDir, seed);
      await stat(join(server.config.cacheDir, "deps", "prepared-marker.js"));
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("fixture servers reject configuration that would change dependency optimization", async () => {
  await assert.rejects(
    createServer({ ...config, optimizeDeps: { include: ["yaml"] } }),
    /share one dependency optimizer/,
  );
  await assert.rejects(
    createServer({
      ...config,
      plugins: [{ name: "resolver", resolveId: () => null }],
    }),
    /resolver uses resolveId/,
  );
});

test("concurrent fixture servers own distinct optimizer caches and retire only their own files", async () => {
  const servers = [];
  try {
    servers.push(await createServer(config));
    servers.push(await createServer(config));
    const [first, second] = servers;
    assert.notEqual(first.config.cacheDir, second.config.cacheDir);
    assert.notEqual(first.config.cacheDir, join(root, "node_modules/.vite"));
    const retained = join(second.config.cacheDir, "retained-dependency.js");
    await writeFile(retained, "export default 1;");
    await first.close();
    await assert.rejects(stat(first.config.cacheDir), { code: "ENOENT" });
    assert.equal(await readFile(retained, "utf8"), "export default 1;");
    await second.close();
    await assert.rejects(stat(second.config.cacheDir), { code: "ENOENT" });
    await stat(join(seed, "deps"));
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("failed fixture creation cleans its owned cache and preserves the error", async () => {
  let cacheDir;
  const failure = new Error("fixture configuration failed");
  await assert.rejects(
    createServer({
      ...config,
      plugins: [
        {
          name: "fail-fixture-configuration",
          configureServer(server) {
            cacheDir = server.config.cacheDir;
            throw failure;
          },
        },
      ],
    }),
    (error) => error === failure,
  );
  assert.ok(cacheDir);
  await assert.rejects(stat(cacheDir), { code: "ENOENT" });
});

test("browser fixture call sites cannot fall back to Vite's shared default cache", async () => {
  const browser = join(root, "tests/browser");
  for (const name of await readdir(browser)) {
    if (!name.endsWith(".spec.mjs")) continue;
    const source = await readFile(join(browser, name), "utf8");
    if (!source.includes('import { createServer } from "vite"')) continue;
    // This existing test owns a temporary directory through its full lifecycle.
    assert.ok(name === "emoji.spec.mjs", name);
    assert.match(
      source,
      /cacheDir[,:]/,
      `${name} must keep its explicit cache`,
    );
  }
});
