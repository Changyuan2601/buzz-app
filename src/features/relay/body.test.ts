import { expect, it } from "vitest";
import { objectBody } from "./body";

it("parses only JSON object bodies", () => {
  expect(objectBody('{"name":"Alpha"}')).toEqual({ name: "Alpha" });
  expect(objectBody(' \t\r\n{"a":1} ')).toEqual({ a: 1 });
  // JSON.parse rejects non-JSON whitespace such as NBSP before an object.
  for (const content of ["", "Alpha", "[]", "null", '"{}"', "{", " {}"])
    expect(objectBody(content)).toBeUndefined();
});
