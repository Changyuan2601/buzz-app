import { expect, it } from "vitest";
import { startingChatTitle } from "./chat-title";

const link = `buzz://message?channel=design&id=${"c".repeat(64)}`;

it("titles a linked chat from the prompt after its leading source link", () => {
  expect(startingChatTitle(`${link} Investigate this failure`)).toBe(
    "Investigate this failure",
  );
  expect(startingChatTitle(`${link}\n${link} Compare both`)).toBe(
    "Compare both",
  );
});

it("keeps a link-only prompt and links later in the prompt", () => {
  expect(startingChatTitle("buzz://channel/design")).toBe(
    "buzz://channel/design",
  );
  expect(startingChatTitle("Look at buzz://channel/design")).toBe(
    "Look at buzz://channel/design",
  );
});
