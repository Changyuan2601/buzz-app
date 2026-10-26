import type { ComponentType } from "react";

export type BrowserViewProps = Readonly<{
  url: string;
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
