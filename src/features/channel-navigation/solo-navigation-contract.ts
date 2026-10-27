// FOUNDATION: Public Solo region contract. Ownership stays label-based and host-enforced.
import type { ComponentType, ReactElement, ReactNode } from "react";
import type { JsonValue } from "../navigation/targets";

export type SoloRegionBinding = Readonly<{
  scope: string;
  viewer: string;
  incarnation: string;
}>;
export type SoloRegionSnapshot = Readonly<{
  status: "loading" | "ready" | "unavailable";
  binding: SoloRegionBinding;
  revision: number;
  model?: unknown;
  notice?: string;
}>;
export type SoloRegionAction = Readonly<{
  id: string;
  label: string;
  icon: ReactElement | "plus" | "view";
  onSelect: () => void | Promise<void>;
  menu?: () => readonly Readonly<{
    id: string;
    label: string;
    checked?: boolean;
    group?: string;
    onSelect: () => void | Promise<void>;
  }>[];
}>;
export type SoloRegionSource = Readonly<{
  id: string;
  title: string;
  icon: ReactNode;
  order?: number;
  bind(binding: SoloRegionBinding, signal: AbortSignal): void;
  subscribe(listener: () => void): () => void;
  read(binding: SoloRegionBinding): SoloRegionSnapshot;
  component: ComponentType<SoloRegionProps>;
  actions?: (binding: SoloRegionBinding) => readonly SoloRegionAction[];
}>;
export type SoloChatInput = Readonly<{
  channelId: string;
  title: string;
  members: readonly string[];
  named?: boolean;
  ttlSeconds?: number;
}>;
export type SoloRegionHandle = Readonly<{
  label: string;
  createChat(binding: SoloRegionBinding, input: SoloChatInput): Promise<void>;
  classify(binding: SoloRegionBinding, channelId: string): Promise<void>;
}>;
export type SoloRegionProps = Readonly<{
  binding: SoloRegionBinding;
  snapshot: SoloRegionSnapshot & Readonly<{ status: "ready" }>;
  live: ReadonlySet<string>;
  current?: string;
  revealRequests: Readonly<{
    subscribe(listener: (channelId: string) => void): () => void;
  }>;
  state: Readonly<{
    get(): JsonValue | undefined;
    set(value: JsonValue): boolean;
  }>;
  ui: Readonly<{
    Destination: ComponentType<SoloDestinationProps>;
    Disclosure: ComponentType<SoloDisclosureProps>;
  }>;
}>;
export type SoloDisclosureProps = Readonly<{
  label: string;
  summary: string;
  expanded: boolean;
  controls: string;
  onToggle(): void;
}>;
export type SoloDestinationProps = Readonly<{
  channelId: string;
  label?: string;
  /** Empty suppresses the channel preview; undefined keeps the fallback. */
  supporting?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  status?:
    | "needs-you"
    | "running"
    | "failed"
    | "scheduled"
    | "waiting"
    | "done";
  variant?: "row" | "card";
  /** Shared card surface; inset uses the inset surface for its own interaction states. */
  cardTone?: "tonal" | "inset";
  /** Paint the whole card as the current accepted drag destination. */
  dropTarget?: boolean;
  details?: ReactNode;
  footer?: ReactNode;
  disclosure?: Readonly<{
    /** Leading is an always-visible icon beside the primary destination. */
    /** Trailing puts an independent disclosure immediately after the project title. */
    placement?: "footer" | "leading" | "trailing";
    label: string;
    summary: string;
    expanded: boolean;
    avatars?: readonly ReactNode[];
    onToggle(): void;
  }>;
  children?: ReactNode;
  indent?: 0 | 1 | 2;
  menuActions?: readonly SoloRegionAction[];
}>;
export type SoloNavigation = Readonly<{
  version: 2;
  registerSource(source: SoloRegionSource): SoloRegionHandle;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    soloNavigation?: SoloNavigation;
  }
}
