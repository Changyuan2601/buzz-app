import { test as base, expect } from "./playwright-test.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer } from "./vite-server.mjs";

// Only stateless source serving is shared. Playwright still owns a fresh context
// per test; fixtures with mutable server middleware must keep their own server.
export const test = base.extend({
  builderlabOrigin: ["", { scope: "worker", option: true }],
  sourceOrigin: [
    async ({ builderlabOrigin }, use) => {
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envFile: false,
        define: builderlabOrigin
          ? {
              "import.meta.env.VITE_BUZZ_BUILDERLAB_URL":
                JSON.stringify(builderlabOrigin),
            }
          : {},
        plugins: [react()],
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      try {
        await server.listen();
        await use(`http://127.0.0.1:${server.httpServer.address().port}`);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ sourceOrigin }, use) => use(sourceOrigin),
});
export { expect };
