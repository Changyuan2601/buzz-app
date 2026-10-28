import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en-US",
  locales: ["en-US", "pt-BR", "zh-CN"],
  fallbackLocales: { default: "en-US" },
  catalogs: [
    {
      path: "<rootDir>/src/features/localization/locales/{locale}",
      include: ["<rootDir>/src"],
      // Tests look up shipped messages; they must not keep one in the catalog.
      exclude: ["**/*.test.*"],
    },
  ],
  // Line numbers churn on every edit; file origins still give translators context.
  format: formatter({ lineNumbers: false }),
  // Macros read the host's reactive store, so components need no provider.
  runtimeConfigModule: {
    i18n: ["#localization", "i18n"],
    useLingui: ["#localization", "useLingui"],
  },
});
