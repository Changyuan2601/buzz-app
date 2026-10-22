// @vitest-environment node
import { describe, expect, it } from "vitest";
import { meshGooseEnv, MeshGoose } from "./meshGoose";
import { fakeSpawn } from "../goose/goose-testing";
import type { InlineTurn } from "./meshAgent";

it("does not count an empty Goose completion as a Buzz answer", async () => {
  const fake = fakeSpawn();
  const mesh = new MeshGoose({
    spawn: async (id, options) => {
      if (id !== "workspace") return fake.spawn(id, options);
      options?.onStdout?.("/home/test\n");
      return {
        exited: Promise.resolve(0),
        write: async () => {},
        end: async () => {},
        kill: async () => {},
      };
    },
    serve: fake.serve,
    current: async () => true,
  });
  try {
    await expect(
      mesh.run({
        delivery: {
          agent: { pubkey: "a".repeat(64) },
          signal: new AbortController().signal,
        },
        inference: {
          baseUrl: "http://127.0.0.1:4111/lease/v1",
          model: "mesh",
          lease: "lease",
        },
        cwd: "/work",
        context: { channel: "chan" },
        sessionKey: "one",
        system: "Be brief",
        prompt: "Hello",
      } as InlineTurn),
    ).resolves.toEqual({ text: "", answered: false });
  } finally {
    mesh.dispose();
  }
});

describe("meshGooseEnv", () => {
  it("points goose's OpenAI provider at the leased loopback route", () => {
    expect(
      meshGooseEnv(
        "http://127.0.0.1:4111/lease-1/v1",
        "/home/me/.buzz/.mesh-goose",
      ),
    ).toEqual({
      GOOSE_PATH_ROOT: "/home/me/.buzz/.mesh-goose",
      GOOSE_DISABLE_KEYRING: "1",
      OPENAI_HOST: "http://127.0.0.1:4111",
      OPENAI_BASE_PATH: "lease-1/v1/chat/completions",
      OPENAI_API_KEY: "mesh-local",
    });
  });
});
