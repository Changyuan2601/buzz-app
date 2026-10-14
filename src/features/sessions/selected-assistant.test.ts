// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  readSelectedAssistant,
  writeSelectedAssistant,
} from "./selected-assistant";

beforeEach(() => localStorage.clear());

it("persists an assistant by account/community scope and chat", () => {
  const assistant = "a".repeat(64);
  expect(writeSelectedAssistant("community:viewer", "chat-a", assistant)).toBe(
    true,
  );
  expect(readSelectedAssistant("community:viewer", "chat-a")).toBe(assistant);
  expect(readSelectedAssistant("community:viewer", "chat-b")).toBe("");
  expect(readSelectedAssistant("other-community:viewer", "chat-a")).toBe("");
  expect(readSelectedAssistant("community:other-viewer", "chat-a")).toBe("");
});

it("clears invalid or empty assistant intent", () => {
  const assistant = "b".repeat(64);
  writeSelectedAssistant("scope", "chat", assistant);
  writeSelectedAssistant("scope", "chat", "");
  expect(readSelectedAssistant("scope", "chat")).toBe("");
  writeSelectedAssistant("scope", "chat", "not-a-key");
  expect(readSelectedAssistant("scope", "chat")).toBe("");
});
