import { expect, it } from "vitest";
import { locales, matchLocale, resolveLocale, sourceLocale } from "./locales";

const shipped = locales.map(({ tag }) => tag);

it("matches exact tags, then the base language", () => {
  expect(matchLocale("pt_br", shipped)).toBe("pt-BR");
  expect(matchLocale(" PT ", shipped)).toBe("pt-BR");
  expect(matchLocale("pt-PT", shipped)).toBe("pt-BR");
  expect(matchLocale("en-GB", shipped)).toBe("en-US");
  expect(matchLocale("fr-FR", shipped)).toBeUndefined();
  expect(matchLocale("", shipped)).toBeUndefined();
  expect(matchLocale(42, shipped)).toBeUndefined();
});

it("prefers an exact regional match over an earlier sibling", () => {
  const regional = ["pt-PT", "pt-BR"] as const;
  expect(matchLocale("pt-BR", regional)).toBe("pt-BR");
  expect(matchLocale("pt-AO", regional)).toBe("pt-PT");
});

it("prefers the saved locale, then system order, then the source", () => {
  const resolve = (saved: unknown, preferred: string[]) =>
    resolveLocale(saved, preferred, shipped, sourceLocale);
  expect(resolve("pt-BR", ["en-US"])).toBe("pt-BR");
  expect(resolve("invalid", ["fr-FR", "pt-BR", "en-US"])).toBe("pt-BR");
  expect(resolve(null, ["fr-FR"])).toBe("en-US");
});

it("registers canonical, unique tags with the source first", () => {
  expect(shipped[0]).toBe(sourceLocale);
  expect(new Set(shipped).size).toBe(shipped.length);
  for (const tag of shipped)
    expect(Intl.getCanonicalLocales(tag)).toEqual([tag]);
});

it("registers exactly the locales Lingui extracts catalogs for", async () => {
  const { default: config } = await import("../../../lingui.config");
  expect(config.sourceLocale).toBe(sourceLocale);
  expect(config.locales).toEqual(shipped);
});
