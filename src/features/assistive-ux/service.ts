import { Service, type Context } from "@deepseek-ai/cordis";
import type { RelaySession } from "../relay/session";
import type { AssistiveProgress } from "./progress";

export interface AssistiveUx {
  /** Capture a concrete identity/community session, never the global selection. */
  forSession(session: RelaySession): AssistiveProgress;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    assistiveUx: AssistiveUx;
  }
}

/** Always-on app entry point; the existing community session owns sync and lifetime. */
export class AssistiveUxService extends Service implements AssistiveUx {
  constructor(ctx: Context) {
    super(ctx, "assistiveUx");
  }
  forSession(session: RelaySession) {
    return session.assistiveProgress;
  }
}
