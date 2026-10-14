/**
 * Host-owned, device-local UI language. Plugin and user content are not translated.
 *
 * The document stays in the source language while translation is partial; each
 * translated region declares `lang` so untranslated host copy keeps English
 * language metadata.
 */
import { createInstance, type TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type LocaleDefinition,
  locales,
  matchLocale,
  resolveLocale,
  sourceLocale,
} from "./locales";

export const LANGUAGE_KEY = "buzz-language.v1";

export type Localized = { t: TFunction; lang: string };

export function createLocalization(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
  registry: readonly LocaleDefinition[] = locales,
) {
  const tags = registry.map(({ tag }) => tag);
  const saved = () => {
    try {
      return host?.localStorage.getItem(LANGUAGE_KEY);
    } catch {
      return undefined;
    }
  };
  const restore = () =>
    resolveLocale(saved(), host?.navigator.languages ?? [], tags, sourceLocale);
  const i18n = createInstance({
    resources: Object.fromEntries(
      registry.map(({ tag, catalogue }) => [tag, { translation: catalogue }]),
    ),
    lng: restore(),
    fallbackLng: sourceLocale,
    supportedLngs: tags,
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    initAsync: false,
  });
  void i18n.init();
  // Another window saved a choice; re-read so a stale event cannot undo it.
  host?.addEventListener("storage", (event) => {
    if (event.key === LANGUAGE_KEY || event.key === null)
      void i18n.changeLanguage(restore());
  });
  return {
    i18n,
    current: () => i18n.resolvedLanguage ?? sourceLocale,
    /** Applies the locale for this session; resolves false if it was not saved. */
    async setLocale(tag: string) {
      const next = matchLocale(tag, tags);
      if (!next) throw new Error(`Unsupported locale: ${tag}`);
      let saved = true;
      try {
        if (!host) throw new Error("No browser storage");
        host.localStorage.setItem(LANGUAGE_KEY, next);
      } catch {
        saved = false;
      }
      await i18n.changeLanguage(next);
      return saved;
    },
  };
}

export const localization = createLocalization();

/** Translator and `lang` for host-owned text in the active UI language. */
export function useLocalization(): Localized {
  const { t, i18n } = useTranslation("translation", {
    i18n: localization.i18n,
  });
  const lang = i18n.resolvedLanguage ?? sourceLocale;
  return useMemo(() => ({ t, lang }), [t, lang]);
}
