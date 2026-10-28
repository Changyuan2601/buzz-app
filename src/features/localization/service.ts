/**
 * Host-owned, device-local UI language. Plugin and user content are not translated.
 *
 * Lingui macros resolve `i18n` and `useLingui` here (see `lingui.config.ts`), so
 * components re-render on a language change without a React provider. The
 * document stays in the source language while translation is partial; each
 * translated region declares `lang={i18n.locale}` so untranslated host copy keeps
 * English language metadata.
 */
import { type I18n, type Messages, setupI18n } from "@lingui/core";
import { useMemo, useSyncExternalStore } from "react";
import {
  type LocaleDefinition,
  locales,
  matchLocale,
  resolveLocale,
  sourceLocale,
} from "./locales";
import { messages as enUS } from "./locales/en-US.po";
import { messages as ptBR } from "./locales/pt-BR.po";
import { messages as zhCN } from "./locales/zh-CN.po";

export const LANGUAGE_KEY = "buzz-language.v1";

type Tag = (typeof locales)[number]["tag"];
const catalogs: Record<Tag, Messages> = {
  "en-US": enUS,
  "pt-BR": ptBR,
  "zh-CN": zhCN,
};

export function createLocalization(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
  registry: readonly LocaleDefinition[] = locales,
  messages: Readonly<Record<string, Messages>> = catalogs,
) {
  const tags = registry.map(({ tag }) => tag);
  let unsaved = false;
  const listeners = new Set<() => void>();
  const setUnsaved = (next: boolean) => {
    if (unsaved === next) return;
    unsaved = next;
    for (const listener of listeners) listener();
  };
  const resolve = (saved: unknown) =>
    resolveLocale(saved, host?.navigator.languages ?? [], tags, sourceLocale);
  const saved = () => {
    try {
      return host?.localStorage.getItem(LANGUAGE_KEY);
    } catch {
      return undefined;
    }
  };
  const i18n = setupI18n({ locale: resolve(saved()), messages });
  // Another window saved a choice; re-read so a stale event cannot undo it.
  host?.addEventListener("storage", (event) => {
    if (event.key !== LANGUAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== host.localStorage) return;
      const next = resolve(host.localStorage.getItem(LANGUAGE_KEY));
      setUnsaved(false);
      i18n.activate(next);
    } catch {
      // Keep the session choice and retry state if storage is still unavailable.
    }
  });
  return {
    i18n,
    unsaved: () => unsaved,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Applies the locale for this session; returns false if it was not saved. */
    setLocale(tag: string) {
      const next = matchLocale(tag, tags);
      if (!next) throw new Error(`Unsupported locale: ${tag}`);
      let saved = true;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(LANGUAGE_KEY, next);
      } catch {
        saved = false;
      }
      i18n.activate(next);
      setUnsaved(!saved);
      return saved;
    },
  };
}

export const localization = createLocalization();
export const i18n: I18n = localization.i18n;

/** Lingui's `useLingui` contract, re-rendering on locale changes without a provider. */
export function useLingui() {
  const locale = useSyncExternalStore(
    (change) => i18n.on("change", change),
    () => i18n.locale,
  );
  // A new `_` per locale lets memoized translations depend on it.
  return useMemo(() => ({ i18n, _: i18n._.bind(i18n), locale }), [locale]);
}
