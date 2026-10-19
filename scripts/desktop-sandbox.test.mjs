import { expect, it } from "vitest";
import {
  eraseSandbox,
  sandboxConfig,
  sandboxPaths,
  sandboxed,
  validSandbox,
} from "./desktop-sandbox.mjs";

it("accepts only plain sandbox names", () => {
  for (const name of ["onboarding", "a", "fresh-2", "x".repeat(32)])
    expect(validSandbox(name), name).toBe(true);
  for (const name of ["", "Clean", "a.b", "a/b", "a b", "../x", "x".repeat(33)])
    expect(validSandbox(name), name).toBe(false);
  expect(validSandbox(undefined)).toBe(false);
});

it("keeps every sandbox path apart from the shared app's", () => {
  const paths = sandboxPaths("onboarding", "/Users/someone");
  expect(paths.identifier).toBe("dev.local.buzz.foundation.sandbox.onboarding");
  for (const path of [paths.appData, paths.caches, paths.webkitData])
    expect(path).toContain(".sandbox.onboarding");
  expect(sandboxed("dev.local.buzz.foundation.agents", "onboarding")).toBe(
    "dev.local.buzz.foundation.agents.sandbox.onboarding",
  );
});

it("holds every window back for the sandbox's data store", () => {
  const conf = {
    identifier: "dev.local.buzz.foundation",
    app: { windows: [{ title: "Buzz Foundation", width: 1200 }, {}] },
  };
  const config = sandboxConfig("onboarding", conf);
  expect(config.identifier).toBe(
    "dev.local.buzz.foundation.sandbox.onboarding",
  );
  expect(config.app.windows).toHaveLength(2);
  expect(config.app.windows[0]).toEqual({
    title: "Buzz Foundation (sandbox: onboarding)",
    width: 1200,
    create: false,
  });
  expect(config.app.windows[1].create).toBe(false);
});

it("refuses to erase anything for an invalid name", () => {
  expect(() => eraseSandbox("")).toThrow("Invalid sandbox name");
  expect(() => eraseSandbox("../x")).toThrow("Invalid sandbox name");
});
