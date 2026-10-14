import { fixtureAliases } from "../relay-config.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// The global setup sets this to a directory that lives for one Playwright run.
export const buildCacheVariable = "BUZZ_BROWSER_BUILD_CACHE";

export default async function setupBuildCache() {
  const directory = await mkdtemp(join(tmpdir(), "buzz-browser-builds-"));
  process.env[buildCacheVariable] = directory;
  return () => rm(directory, { recursive: true, force: true });
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

// Workers of one run share each build variant. The source does not change
// during a run, so a variant is built once. One worker takes the lock and
// builds; the others wait for the finished directory or the failure note.
async function sharedBuild(cache, options, buildInto) {
  const key = createHash("sha256")
    .update(JSON.stringify(options))
    .digest("hex")
    .slice(0, 16);
  const done = join(cache, key);
  const failed = join(cache, `${key}.failed`);
  try {
    await mkdir(join(cache, `${key}.lock`));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    for (;;) {
      if (await exists(done)) return done;
      if (await exists(failed))
        throw new Error(
          `Another worker failed to build this app variant:\n${await readFile(failed, "utf8")}`,
        );
      await delay(100);
    }
  }
  const staging = join(cache, `${key}.staging`);
  try {
    await buildInto(staging);
    await rename(staging, done);
    return done;
  } catch (error) {
    await writeFile(failed, String(error?.stack ?? error));
    throw error;
  }
}

// Playwright owns this worker-scoped fixture. Only compiled assets are shared;
// each test still owns its server, identities, relay state and browser storage.
// With the global setup, workers of one run share each variant's build.
// Without it (other configs), each worker builds its own.
export async function buildApp(
  {
    developmentReact,
    pluginFixtures,
    companionFixture,
    localAgentActivity,
    pairingFixture,
  },
  use,
) {
  const config = (directory) => {
    const config = {
      root,
      mode: "production",
      configFile: false,
      envFile: false, // Never read the developer's live identity configuration.
      logLevel: "error",
      plugins: [
        react(),
        ...(pairingFixture
          ? [
              {
                name: "pairing-fixture",
                transform(code, id) {
                  if (id !== join(root, "src/bundled/pairing/index.tsx"))
                    return;
                  return code.replace(
                    'import { PairingSettings } from "./PairingSettings";',
                    `import { PairingFixture as PairingSettings } from ${JSON.stringify(join(root, "tests/browser/pairing-fixture.tsx"))};`,
                  );
                },
              },
            ]
          : []),
        ...(pluginFixtures || companionFixture
          ? [
              {
                name: "fixture-installed-plugins",
                transform(code, id) {
                  if (id !== join(root, "src/bundled/index.ts")) return;
                  const source = pluginFixtures
                    ? "plugin-fixtures"
                    : "companion-fixture";
                  const exported = pluginFixtures
                    ? "fixturePlugins"
                    : "companionPlugins";
                  // Keep the companion after the built-ins so catalog scrolling
                  // remains part of its focus-restoration journey.
                  const injected = pluginFixtures
                    ? code.replace("= [", `= [ ...${exported},`)
                    : code.replace(/\];\s*$/, `].concat(${exported});`);
                  return `import { ${exported} } from ${JSON.stringify(join(root, `tests/browser/${source}.tsx`))};\n${injected}`;
                },
              },
            ]
          : []),
      ],
      define: {
        ...(developmentReact ? { "import.meta.env.DEV": "true" } : {}),
        "import.meta.env.VITE_BUZZ_LIVE": '"1"',
        "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
          JSON.stringify(fixtureAliases),
        ...(developmentReact
          ? { "process.env.NODE_ENV": '"development"' }
          : {}),
      },
      build: { outDir: join(directory, "dist"), emptyOutDir: true },
    };
    if (localAgentActivity)
      config.plugins.push({
        name: "fixture-local-agent",
        transform(code, id) {
          const fixture = JSON.stringify(
            join(root, "tests/browser/local-agents-fixture.ts"),
          );
          if (id === join(root, "src/features/agents/native.ts")) {
            const start = code.indexOf("export const nativeAgents =");
            if (start < 0) throw new Error("Missing native Agents seam");
            return (
              code.slice(0, start) +
              `import { localAgentsNative } from ${fixture};\nexport const nativeAgents = localAgentsNative;`
            );
          }
          if (id === join(root, "src/bundled/index.ts"))
            return (
              `import { localAgentPlugin } from ${fixture};\n` +
              code.replace("= [", "= [localAgentPlugin,")
            );
        },
      });
    return config;
  };
  const start = performance.now();
  const cache = process.env[buildCacheVariable];
  if (cache) {
    const directory = await sharedBuild(
      cache,
      {
        developmentReact,
        pluginFixtures,
        companionFixture,
        localAgentActivity,
        pairingFixture,
      },
      (directory) => build(config(directory)),
    );
    await use({
      config: config(directory),
      durationMs: performance.now() - start,
    });
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "buzz-browser-build-"));
  try {
    const built = config(directory);
    await build(built);
    await use({ config: built, durationMs: performance.now() - start });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
