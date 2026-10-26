import type { ComponentType } from "react";

/** One signed-in Builderlab lifetime; never passed to website JavaScript. */
export type BuilderlabViewerSession = Readonly<{
  credential: string;
  storage: string;
  signal: AbortSignal;
}>;

export type BrowserViewProps = Readonly<{
  url: string;
  /** Bootstrap only the configured Builderlab tenant's app using its native viewer exchange. */
  builderlab?: BuilderlabViewerSession;
  /** Keeps the website's cookies and storage under this name between opens
   * and restarts (1-64 of a-z, 0-9, `-`, `_`, `.`), where the platform can hold
   * them apart from Buzz's own. Without it each open is a private session. */
  storage?: string;
  /** Names the view's tab until the website has a title, and while a hidden
   * tab has not opened it yet. */
  label?: string | undefined;
}>;

export interface Browser {
  readonly available: boolean;
  readonly View: ComponentType<BrowserViewProps>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    browser: Browser;
  }
}
