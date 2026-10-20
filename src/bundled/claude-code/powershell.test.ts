import { expect, it, vi } from "vitest";
import type { Spawn } from "./claude";
import { encodeCommand, withPowerShell } from "./powershell";

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

it("starts setup steps in PowerShell and Buzz's copy as its data program", async () => {
  const spawn = vi.fn<Spawn>(async () => ({}) as never);
  const windows = withPowerShell(spawn);
  await windows("install", { args: ["2.1.304", "win32-x64", "a".repeat(64)] });
  const [id, options] = spawn.mock.calls[0] ?? [];
  expect(id).toBe("claude-ps");
  expect(options?.args).toHaveLength(1);
  expect(decode(options?.args?.[0] ?? "")).toMatch(
    /\n\} 'install' '2\.1\.304' 'win32-x64' 'a{64}'$/,
  );
  await windows("claude", { args: ["--version"], cwd: "~" });
  expect(spawn).toHaveBeenLastCalledWith("claude-exe", {
    args: ["--version"],
    cwd: "~",
  });
  // A release named to test it is `next`, until `use` makes it current.
  const pinned = { env: { BUZZ_CLAUDE_VERSION: "2.1.304" } };
  await windows("claude", pinned);
  expect(spawn).toHaveBeenLastCalledWith("claude-next", pinned);
  await windows("read", { args: ["./x"] });
  expect(spawn).toHaveBeenLastCalledWith("read", { args: ["./x"] });
});
