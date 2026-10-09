import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isNativeMediaSource } from "./attachment-source";

/** `http://127.0.0.1:<port>/<token>/`, where `<video>` and `<audio>` load
 * relay media (`src-tauri/src/relay/media_stream.rs`): WebKitGTK cannot play
 * `buzz-media`, and a closed player's connection lets native code release its
 * spool. `null` if the listener did not start or its address cannot be
 * read; `undefined` until known. */
let base: string | null | undefined;
let loading = false;
const listeners = new Set<() => void>();
const snapshot = () => base;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loading) {
    loading = true;
    invoke<string | null>("media_stream_base")
      .then(
        (value) => value ?? null,
        () => null,
      )
      .then((value) => {
        base = value;
        for (const notify of listeners) notify();
      });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** A media element's `src` for `source`. A native relay source waits for the
 * listener's address; without a listener it is `unavailable`, which callers
 * show as failed playback. `buzz-media` is no fallback: its reads cannot be
 * cancelled when the player closes, so they would keep spools alive. */
export function useMediaElementSource(source: string | undefined): {
  src: string | undefined;
  unavailable: boolean;
} {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!source || !isNativeMediaSource(source))
    return { src: source, unavailable: false };
  if (!current) return { src: undefined, unavailable: current === null };
  // `buzz-media` carries the encoded relay URL as its whole path.
  return {
    src: current + new URL(source).pathname.slice(1),
    unavailable: false,
  };
}
