# Localization

Settings → Language stores a device-local UI language (`buzz-language.v1`).
Without a saved choice, Buzz uses the first supported language in the system
preference order, then English. The host owns translation; plugin, relay, and
user-authored content are not translated.

Translation is partial. The document stays `lang="en"`, and each translated
region declares `lang` from `useLocalization()` so assistive technology reads
untranslated host copy as English and translated copy in the chosen language.
Put `lang` on the element that owns translated text or accessible names, not on
a container that also holds plugin or user content. Host copy rendered outside
its region, such as a toast, passes `lang` explicitly.

## Translating host copy

1. Add the English text to `src/features/localization/catalogues/en-US.ts`.
   Keys are flat (`area.purpose`); English is the source and runtime fallback.
2. Add the same key to every other catalogue. The `Catalogue` type rejects a
   missing or unknown key, and `locales.test.ts` checks that `{{placeholders}}`
   match the English source.
3. Render it with `const { t, lang } = useLocalization()` and mark the owning
   element with `lang={lang}`.

## Adding a language

1. Add `catalogues/<tag>.ts` exporting a complete `Catalogue`.
2. Register it in `locales` (`src/features/localization/locales.ts`) with its
   canonical BCP 47 tag and its name written in that language.

System matching takes an exact tag first, then the first registered locale
with the same base language, so list the default regional variant first.
Right-to-left layout, plural categories beyond English's, and lazy catalogue
loading are not supported yet.
