import { useLingui } from "@lingui/react/macro";
import { useSyncExternalStore } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Header } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Select } from "../shared/design-system/ui/Select";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { locales } from "../features/localization/locales";
import { localization } from "../features/localization/service";

const options = locales.map(({ tag, name }) => ({
  value: tag,
  label: name,
  lang: tag,
}));

export function LanguageSettings({ active = true }: { active?: boolean }) {
  const { t, i18n } = useLingui();
  const lang = i18n.locale;
  const unsaved = useSyncExternalStore(
    localization.subscribe,
    localization.unsaved,
  );
  const choose = (tag: string) => void localization.setLocale(tag);
  const label = t`App language`;
  return (
    <section lang={lang} aria-labelledby="language-settings-title">
      <Header id="language-settings-title" title={t`Language`} />
      <SettingsGroup>
        <PreferenceRow
          title={label}
          subtitle={t`Some parts of Buzz are not translated yet.`}
          trailing={
            <Select
              variant="compact"
              lang={lang}
              label={label}
              value={lang}
              groups={[{ label, options }]}
              onValueChange={choose}
            />
          }
        />
      </SettingsGroup>
      {active && unsaved && (
        <ToastNotice
          lang={lang}
          title={t`Language wasn’t saved`}
          description={t`This language is active, but could not be saved on this device. Try again.`}
        >
          <Button type="button" size="sm" onClick={() => choose(lang)}>
            {t`Retry saving language`}
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
