import type { enUS } from "./catalogues/en-US";

declare module "i18next" {
  interface CustomTypeOptions {
    keySeparator: false;
    nsSeparator: false;
    resources: { translation: typeof enUS };
  }
}
