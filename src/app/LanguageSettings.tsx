import { useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Header } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Select } from "../shared/design-system/ui/Select";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { locales } from "../features/localization/locales";
import {
  localization,
  useLocalization,
} from "../features/localization/service";

const options = locales.map(({ tag, name }) => ({ value: tag, label: name }));

export function LanguageSettings({ active = true }: { active?: boolean }) {
  const { t, lang } = useLocalization();
  const [unsaved, setUnsaved] = useState(false);
  const choose = (tag: string) =>
    void localization.setLocale(tag).then((saved) => setUnsaved(!saved));
  return (
    <section lang={lang} aria-labelledby="language-settings-title">
      <Header
        id="language-settings-title"
        title={t("settings.section.language")}
      />
      <SettingsGroup>
        <PreferenceRow
          title={t("language.label")}
          subtitle={t("language.description")}
          trailing={
            <Select
              variant="compact"
              label={t("language.label")}
              value={lang}
              groups={[{ label: t("language.label"), options }]}
              onValueChange={choose}
            />
          }
        />
      </SettingsGroup>
      {active && unsaved && (
        <ToastNotice
          lang={lang}
          title={t("language.saveTitle")}
          description={t("language.saveError")}
        >
          <Button type="button" size="sm" onClick={() => choose(lang)}>
            {t("language.retry")}
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
