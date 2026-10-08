import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { bundledHost } from "./first-run";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

it("requests under the bundled Builderlab grant without a plugin owner", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: "{}",
  });
  const request = { url: "https://app.builderlab.xyz/api/goose/v1/auth/me" };
  await bundledHost.request(request);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "block.builderlab",
    revision: "bundled",
    request,
  });
  expect(await bundledHost.runCommand("any")).toBeNull();
});
