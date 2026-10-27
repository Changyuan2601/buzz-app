import { expect, it } from "vitest";
import { keyedRead } from "./handles";

it("keeps what a key read before while its content is the same", () => {
  let sessions: Record<string, { key: string; busy: boolean }[]> = {
    a: [{ key: "one", busy: false }],
    b: [{ key: "two", busy: true }],
  };
  // Each read builds new arrays, as the runtimes' saved-conversation reads do.
  const handle = keyedRead(
    (key) => (sessions[key] ?? []).map((session) => ({ ...session })),
    () => () => {},
    [],
  );
  const a = handle.read("a");
  const b = handle.read("b");
  expect(handle.read("a")).toBe(a);
  sessions = { ...sessions, a: [{ key: "one", busy: true }] };
  const changed = handle.read("a");
  expect(changed).not.toBe(a);
  expect(changed).toEqual([{ key: "one", busy: true }]);
  expect(handle.read("b")).toBe(b);
});
