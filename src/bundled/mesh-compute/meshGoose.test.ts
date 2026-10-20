// @vitest-environment node
import { describe, expect, it } from "vitest";
import { meshGooseEnv } from "./meshGoose";

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
