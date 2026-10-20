import type { ObserverFrame } from "../agents/observer";

export type ArchiveSettings = Readonly<{
  observer: boolean;
  metrics: boolean;
  observerDays: number;
  revision: number;
  location: "device" | "broker";
  path: string;
  bytes: number;
}>;
export type ArchivePage = Readonly<{
  agents: readonly string[];
  records: readonly (ObserverFrame & { receivedAt: number })[];
  before: number | null;
  skipped: number;
  revision: number;
}>;
export type ArchiveRequest =
  | { action: "settings" }
  | {
      action: "configure";
      observer: boolean;
      metrics: boolean;
      observerDays: number;
      revision: number;
    }
  | { action: "read"; kind: 24200 | 44200; agent?: string; before?: number }
  | { action: "clear"; kind?: 24200 | 44200 };
export type ArchiveHost = {
  location: "device" | "broker";
  settings(signal: AbortSignal): Promise<ArchiveSettings>;
  configure(
    settings: ArchiveSettings,
    signal: AbortSignal,
  ): Promise<ArchiveSettings>;
  read(
    input: { kind: 24200 | 44200; agent?: string; before?: number },
    signal: AbortSignal,
  ): Promise<ArchivePage>;
  clear(kind?: 24200 | 44200): Promise<void>;
};
