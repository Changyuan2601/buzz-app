// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const media = `https://relay.test/media/${"a".repeat(64)}.mp4`;
const source = `buzz-media://localhost/${encodeURIComponent(media)}`;
const base = "http://127.0.0.1:4321/token/";

beforeEach(() => {
  vi.resetModules();
  vi.mocked(invoke).mockReset();
});

async function hook() {
  return (await import("./use-media-element-source")).useMediaElementSource;
}

it("loads a native relay source from the listener once its address is known", async () => {
  vi.mocked(invoke).mockResolvedValue(base);
  const useMediaElementSource = await hook();
  const first = renderHook(() => useMediaElementSource(source));
  expect(first.result.current).toEqual({ src: undefined, unavailable: false });
  const loaded = {
    src: `${base}${encodeURIComponent(media)}`,
    unavailable: false,
  };
  await waitFor(() => expect(first.result.current).toEqual(loaded));
  const second = renderHook(() => useMediaElementSource(source));
  expect(second.result.current).toEqual(loaded);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("media_stream_base");
});

// `buzz-media` reads cannot be cancelled by a closed player, so a native
// source never falls back to it.
const unavailable = { src: undefined, unavailable: true };

it("reports a native source unavailable when the listener did not start", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  const useMediaElementSource = await hook();
  const { result } = renderHook(() => useMediaElementSource(source));
  await waitFor(() => expect(result.current).toEqual(unavailable));
});

it("reports a native source unavailable when the listener's address cannot be read", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("unavailable"));
  const useMediaElementSource = await hook();
  const { result } = renderHook(() => useMediaElementSource(source));
  await waitFor(() => expect(result.current).toEqual(unavailable));
});

it("leaves blob, web and missing sources unchanged", async () => {
  vi.mocked(invoke).mockResolvedValue(base);
  const useMediaElementSource = await hook();
  for (const other of ["blob:tauri://localhost/1", media, undefined])
    expect(
      renderHook(() => useMediaElementSource(other)).result.current,
    ).toEqual({ src: other, unavailable: false });
});
