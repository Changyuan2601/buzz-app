import { describe, expect, it } from "vitest";
import {
  CONTEXT_CHARS,
  errorLine,
  instructions,
  LATEST_CHARS,
  MESSAGE_CHARS,
  overflowed,
  prompt,
} from "./prompt";

describe("instructions", () => {
  it("names the agent and its owner, says what it can't do, then adds the owner's", () => {
    const text = instructions({
      name: "Orchard",
      owner: "Alice",
      instructions: "  Answer in French.  ",
    });
    expect(text).toContain("You are Orchard");
    expect(text).toContain("working for Alice");
    expect(text).toContain("you see only its messages");
    expect(text.endsWith("Your owner's instructions:\nAnswer in French.")).toBe(
      true,
    );
  });

  it("leaves out empty owner instructions", () => {
    expect(
      instructions({ name: "Orchard", owner: "Alice", instructions: " " }),
    ).not.toContain("owner's instructions");
  });
});

describe("prompt", () => {
  it("shows earlier messages in order, then the one to answer", () => {
    expect(
      prompt({
        place: "#general, in a thread",
        earlier: [
          { author: "Alice", text: "Hi" },
          { author: "You (Orchard)", text: "Hello!" },
        ],
        latest: { author: "Alice", text: "@Orchard what's 2+2?" },
      }),
    ).toBe(
      [
        "Earlier messages in #general, in a thread:",
        "Alice: Hi\nYou (Orchard): Hello!",
        "",
        "Latest message in #general, in a thread, from Alice:",
        "@Orchard what's 2+2?",
      ].join("\n"),
    );
  });

  it("keeps the newest earlier messages that fit and clips long ones", () => {
    const earlier = Array.from({ length: 40 }, (_, at) => ({
      author: "Bob",
      text: `${at} ${"x".repeat(MESSAGE_CHARS * 2)}`,
    }));
    const text = prompt({
      place: "a DM",
      earlier,
      latest: { author: "Bob", text: "y".repeat(LATEST_CHARS * 2) },
    });
    expect(text).toContain("Bob: 39 ");
    expect(text).not.toContain("Bob: 0 ");
    expect(text.length).toBeLessThan(CONTEXT_CHARS + LATEST_CHARS + 200);
    expect(text.endsWith(`${"y".repeat(LATEST_CHARS)}…`)).toBe(true);
  });

  it("omits the earlier section when there is nothing before", () => {
    expect(
      prompt({
        place: "a DM",
        earlier: [],
        latest: { author: "A", text: "Hi" },
      }),
    ).toBe("Latest message in a DM, from A:\nHi");
  });
});

describe("fm's errors", () => {
  it("reads its first line without the prefix", () => {
    const error = errorLine(
      "\nError: The session's transcript exceeded the model's context size.\nmore",
      1,
    );
    expect(error).toBe(
      "The session's transcript exceeded the model's context size.",
    );
    expect(overflowed(error)).toBe(true);
    expect(overflowed("Apple Intelligence is not enabled.")).toBe(false);
  });

  it("falls back to the exit code", () => {
    expect(errorLine("  ", 64)).toBe("fm exited with 64");
  });
});
