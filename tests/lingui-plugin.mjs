import { lingui } from "@lingui/vite-plugin";
import { fileURLToPath } from "node:url";

/** Host source uses Lingui macros and imports `.po` catalogs; fixture servers
 * that skip `vite.config.ts` need the same transform. */
export const linguiPlugin = () =>
  lingui({
    macroTransform: true,
    configPath: fileURLToPath(new URL("../lingui.config.ts", import.meta.url)),
  });
