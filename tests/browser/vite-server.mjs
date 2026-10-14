import { createServer as createViteServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linguiPlugin } from "../lingui-plugin.mjs";

// Parallel fixture servers must not invalidate each other's optimized imports.
// Every fixture serves host source, so each also gets the Lingui transform.
export async function createServer(config) {
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-fixture-vite-"));
  try {
    const server = await createViteServer({
      ...config,
      plugins: [...(config.plugins ?? []), linguiPlugin()],
      cacheDir,
    });
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
