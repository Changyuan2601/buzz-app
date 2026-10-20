import { expect, it } from "vitest";
import { ATTENTION_TOOLS } from "./attention";
import { type Listing, respond } from "./rpc";
import {
  type AddedTool,
  addedKey,
  sessionHint,
  sessionTools,
} from "./session-tools";
import { TOOLS } from "./tools";

const tool = (name: string, description = "Does it."): AddedTool => ({
  name,
  description,
  inputSchema: { type: "object" },
  call: async () => "done",
});

it("keys the added tools whatever order plugins started in", () => {
  expect(addedKey([])).toBe("");
  const key = addedKey([tool("notes_add"), tool("tasks_create")]);
  expect(key).not.toBe("");
  expect(addedKey([tool("tasks_create"), tool("notes_add")])).toBe(key);
  expect(
    addedKey([tool("notes_add"), tool("tasks_create", "Creates a task.")]),
  ).not.toBe(key);
});

it("loads the Buzz tools up front, and attention and plugins' tools on search", () => {
  const tools = sessionTools([tool("notes_add")]);
  const load = (name: string) => tools.find((each) => each.name === name)?.load;
  expect(TOOLS.every((each) => load(each.name) === "always")).toBe(true);
  expect(ATTENTION_TOOLS.every((each) => load(each.name) === "search")).toBe(
    true,
  );
  expect(load("notes_add")).toBe("search");
  expect(sessionHint([tool("notes_add"), tool("tasks_create")])).toContain(
    "tools plugins add (notes_add, tasks_create)",
  );
});

it("lists the tools as the harness has it, and without their load by default", async () => {
  const answer = (method: string, listing?: Listing) =>
    respond(undefined, {}, { id: 1, method }, [], listing) as Promise<{
      result: {
        instructions?: string;
        tools?: { name: string; load?: unknown; marked?: unknown }[];
      };
    }>;
  const plain = (await answer("tools/list")).result.tools ?? [];
  expect(plain.map((each) => each.name)).toEqual(
    sessionTools().map((each) => each.name),
  );
  expect(plain.some((each) => "load" in each)).toBe(false);
  expect((await answer("initialize")).result.instructions).toBe(undefined);
  const listing: Listing = {
    instructions: "Search for the rest.",
    tool: ({ name, load }) => ({ name, marked: load === "always" }),
  };
  const shaped = (await answer("tools/list", listing)).result.tools ?? [];
  expect(shaped.find((each) => each.name === "send")?.marked).toBe(true);
  expect(shaped.find((each) => each.name === "watch_add")?.marked).toBe(false);
  expect((await answer("initialize", listing)).result.instructions).toBe(
    "Search for the rest.",
  );
});
