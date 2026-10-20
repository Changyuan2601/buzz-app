import { observerFrame } from "../agents/observer";
import type {
  ArchiveHost,
  ArchivePage,
  ArchiveRequest,
  ArchiveSettings,
} from "./types";

/** One adapter-owned host client. Settings changes update capture, never plugin demand. */
export function archiveClient(
  location: "device" | "broker",
  request: (input: ArchiveRequest, signal?: AbortSignal) => Promise<unknown>,
) {
  const listeners = new Set<(settings: ArchiveSettings) => void>();
  let current: ArchiveSettings | undefined;
  const accept = (value: unknown): ArchiveSettings => {
    const settings = value as ArchiveSettings;
    if (
      !settings ||
      typeof settings.observer !== "boolean" ||
      typeof settings.metrics !== "boolean" ||
      !Number.isInteger(settings.observerDays) ||
      settings.observerDays < 1 ||
      settings.observerDays > 90 ||
      !Number.isSafeInteger(settings.revision) ||
      settings.revision < 0 ||
      settings.location !== location ||
      typeof settings.path !== "string" ||
      !settings.path ||
      !Number.isSafeInteger(settings.bytes) ||
      settings.bytes < 0
    )
      throw new Error("Invalid archive settings");
    if (current && current.revision > settings.revision) return current;
    current = Object.freeze(settings);
    for (const listener of listeners) listener(current);
    return current;
  };
  const host: ArchiveHost = {
    location,
    async settings(signal) {
      const value = await request({ action: "settings" }, signal);
      signal.throwIfAborted();
      return accept(value);
    },
    async configure(settings, signal) {
      const value = await request(
        {
          action: "configure",
          observer: settings.observer,
          metrics: settings.metrics,
          observerDays: settings.observerDays,
          revision: settings.revision,
        },
        signal,
      );
      signal.throwIfAborted();
      return accept(value);
    },
    async read(input, signal) {
      const page = (await request(
        { action: "read", ...input },
        signal,
      )) as ArchivePage;
      if (
        !page ||
        !Array.isArray(page.agents) ||
        page.agents.length > 256 ||
        page.agents.some((key) => !/^[0-9a-f]{64}$/.test(key)) ||
        !Array.isArray(page.records) ||
        page.records.length > 100 ||
        !Number.isSafeInteger(page.skipped) ||
        page.skipped < 0 ||
        page.skipped > 100 ||
        !Number.isSafeInteger(page.revision) ||
        (page.before !== null &&
          (!Number.isSafeInteger(page.before) || page.before <= 0))
      )
        throw new Error("Invalid archive page");
      return {
        ...page,
        records: page.records.map((record) => {
          if (!Number.isSafeInteger(record.receivedAt) || record.receivedAt < 0)
            throw new Error("Invalid archive record");
          return { ...observerFrame(record), receivedAt: record.receivedAt };
        }),
      };
    },
    async clear(kind) {
      await request({
        action: "clear",
        ...(kind === undefined ? {} : { kind }),
      });
      // Refresh revision/capture without making a committed delete depend on a
      // later read. The Settings UI reports its own refresh failure separately.
      await host.settings(new AbortController().signal).catch(() => {});
    },
  };
  return {
    host,
    current: () => current,
    subscribe(listener: (settings: ArchiveSettings) => void) {
      listeners.add(listener);
      if (current) listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
