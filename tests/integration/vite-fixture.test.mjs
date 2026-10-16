import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  build,
  createServer,
  prepareFixtureDependencies,
  preview,
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

// Vite deletes the deps directory before it optimizes again, so a marker
// placed in the prepared cache survives only if the server reuses it.
async function placeMarker() {
  await writeFile(
    join(seed, "deps", "prepared-marker.js"),
    "export default 1;",
  );
}
async function assertReusesPreparedCache(server) {
  const optimizer = server.environments.client.depsOptimizer;
  await optimizer.init();
  assert.ok(optimizer.metadata.optimized.react);
  assert.notEqual(server.config.cacheDir, seed);
  await stat(join(server.config.cacheDir, "deps", "prepared-marker.js"));
}

test("differently configured fixture servers start from the prepared dependencies", async () => {
  await placeMarker();
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
      await assertReusesPreparedCache(server);
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("app builds, previews and fixture servers in one worker do not change each other's mode", async () => {
  // Vite's dependency hash includes NODE_ENV. Unwrapped build() and preview()
  // leave it as production, and the next fixture server optimizes again.
  await placeMarker();
  const directory = await mkdtemp(join(tmpdir(), "buzz-fixture-build-"));
  let server, previewServer;
  try {
    const entry = join(directory, "entry.js");
    await writeFile(
      entry,
      `import ${JSON.stringify(join(root, "src/shared/styles/globals.css"))};`,
    );
    const app = {
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      build: {
        outDir: join(directory, "dist"),
        rollupOptions: { input: entry },
      },
    };
    await build(app);
    assert.equal(process.env.NODE_ENV, nodeEnvBefore);
    previewServer = await preview({
      ...app,
      preview: { host: "127.0.0.1", port: 0 },
    });
    assert.equal(process.env.NODE_ENV, nodeEnvBefore);
    server = await createServer(config);
    assert.equal(process.env.NODE_ENV, nodeEnvBefore);
    await assertReusesPreparedCache(server);
    // postcss.config.js keeps Tailwind's in-process cache apart per mode.
    const css = await server.transformRequest("/src/shared/styles/globals.css");
    assert.match(css.code, /--duration-panel-enter/);
    // A fixture server leaves NODE_ENV=development without the helper; a later
    // app build must still be a production build.
    const later = join(directory, "later.js");
    await writeFile(later, "globalThis.dev = import.meta.env.DEV;");
    const result = await build({
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      build: { write: false, rollupOptions: { input: later } },
    });
    const [chunk] = [result].flat()[0].output;
    assert.match(chunk.code, /globalThis\.dev\s*=\s*(!1|false)/);
  } finally {
    await server?.close();
    await previewServer?.close();
    await rm(directory, { recursive: true, force: true });
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
    if (!name.endsWith(".mjs") || name === "vite-server.mjs") continue;
    const source = await readFile(join(browser, name), "utf8");
    for (const [, names] of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"vite"/g,
    )) {
      // The helper restores NODE_ENV after build and preview; see keepNodeEnv.
      assert.doesNotMatch(
        names,
        /\b(build|preview)\b/,
        `${name} must import build and preview from vite-server.mjs`,
      );
      if (!/\bcreateServer\b/.test(names)) continue;
      // This existing test owns a temporary directory through its full lifecycle.
      assert.ok(name === "emoji.spec.mjs", name);
      assert.match(
        source,
        /cacheDir[,:]/,
        `${name} must keep its explicit cache`,
      );
    }
  }
});
