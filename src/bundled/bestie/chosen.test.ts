// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { setDefaultAgent } from "../../features/solo/default-agent";
import { chooseBestie, readBestie } from "./chosen";

const POLLEN = "a".repeat(64);
const FIZZ = "b".repeat(64);

afterEach(() => localStorage.clear());

it("has no Bestie until one is chosen, in each account and community", () => {
  expect(readBestie("community:me")).toBeUndefined();
  chooseBestie("community:me", POLLEN);
  expect(readBestie("community:me")).toBe(POLLEN);
  expect(readBestie("other:me")).toBeUndefined();
  expect(readBestie("community:someone-else")).toBeUndefined();
});

it("agrees with the default agent chosen in Agents, in both directions", () => {
  // One stored value under two names: the surfaces cannot drift apart.
  setDefaultAgent("community:me", FIZZ);
  expect(readBestie("community:me")).toBe(FIZZ);
  chooseBestie("community:me", POLLEN);
  expect(readBestie("community:me")).toBe(POLLEN);
});

it("keeps a public key exact, and refuses one that is not", () => {
  expect(chooseBestie("community:me", "Pollen")).toBe(false);
  expect(readBestie("community:me")).toBeUndefined();
  expect(chooseBestie("community:me", POLLEN.toUpperCase())).toBe(false);
  expect(readBestie("community:me")).toBeUndefined();
});

it("leaves the Bestie in place when an unusable key is offered", () => {
  chooseBestie("community:me", POLLEN);
  expect(chooseBestie("community:me", "")).toBe(false);
  expect(readBestie("community:me")).toBe(POLLEN);
});
