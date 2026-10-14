# Localization

Settings → Language stores a device-local UI language (`buzz-language.v1`).
Without a saved choice, Buzz uses the first supported language in the system
preference order, then English. The host owns translation; plugin, relay, and
user-authored content are not translated.

Strings use [Lingui](https://lingui.dev) macros and gettext `.po` catalogs in
`src/features/localization/locales/`. English source text is the message, so
code stays readable and translators see full sentences. Lingui resolves `i18n`
and `useLingui` from `#localization` (see `lingui.config.ts`), which re-renders
on a language change without a React provider.

Translation is partial. The document stays `lang="en"`, and each translated
element declares `lang={i18n.locale}` so assistive technology reads untranslated
host copy as English and translated copy in the chosen language. Put `lang` on
the element that owns translated text or accessible names, not on a container
that also holds plugin or user content. Host copy rendered outside its region,
such as a toast, passes `lang` explicitly.

## Translating host copy

1. In a component, `const { t, i18n } = useLingui()` from
   `@lingui/react/macro`, then write ``t`Send message` `` and mark the owning
   element with `lang={i18n.locale}`. Outside components, define
   ``msg`Profile` `` from `@lingui/core/macro` and render it with `i18n._()`.
2. Write whole sentences. Interpolate values (``t`Message #${channelName}` ``),
   never concatenate translated fragments; prefer one message per variant.
3. Run `pnpm i18n:extract` and commit the updated `.po` files. CI runs
   `lingui check sync`, which fails when catalogs are stale.
4. Translate the new `msgstr` entries, or leave them empty: missing
   translations compile to the English source. `lingui check missing` reports
   them.

Translators can edit the `.po` files directly or through a gettext tool such as
Weblate, which reads and writes these catalogs as they are.

## Adding a language

1. Add its canonical BCP 47 tag to `locales` in `lingui.config.ts` and run
   `pnpm i18n:extract` to create `locales/<tag>.po`.
2. Register it in `locales` (`src/features/localization/locales.ts`) with its
   name written in that language, and import its catalog in `service.ts`.

System matching takes an exact tag first, then the first registered locale
with the same base language, so list the default regional variant first.
Right-to-left layout and lazy catalog loading are not supported yet.
