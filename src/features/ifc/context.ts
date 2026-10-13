import type { RelayEvent } from "../relay/events";

/** Versioned facts issued by Rust, pinned to one actual model history. */
export type IfcBinding = Readonly<{
  version: 1;
  sessionId: string;
  community: string;
  channel: string;
  agent: string;
  owner: string;
  relay: string;
  requester: string;
  members: readonly string[];
}>;

export type IfcHistory = Readonly<{
  id: string;
  fresh: boolean;
  /** Opaque persisted metadata is validated by Rust, including legacy records. */
  binding: unknown;
}>;

/** Execution context supplied by the app harness for IFC checks. */
export type IfcContext = Readonly<{
  /** Public key of the executing agent. */
  agent: string;
  /** Signed event that caused the turn. */
  trigger: RelayEvent;
  history?: IfcHistory;
  /** App-only receipt; never serialized to the host or exposed to the model. */
  onBinding?: (binding: IfcBinding) => void;
}>;
