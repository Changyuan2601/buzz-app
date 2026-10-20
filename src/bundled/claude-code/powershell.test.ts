import { expect, it } from "vitest";
import { encodeCommand } from "./powershell";

const decode = (encoded: string) => {
  const binary = atob(encoded);
  let text = "";
  for (let i = 0; i < binary.length; i += 2)
    text += String.fromCharCode(
      binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8),
    );
  return text;
};

it("calls the script with each argument as a single-quoted literal", () => {
  expect(
    decode(
      encodeCommand("# note\n  # indented\nexit 0", [
        "use",
        "it's",
        "",
        "a ’ b",
      ]),
    ),
  ).toBe("& {\nexit 0\n} 'use' 'it''s' '' 'a ’’ b'");
});

it("refuses a command too long for a Windows command line", () => {
  expect(() => encodeCommand("x".repeat(20_000), [])).toThrow(/too long/);
});
