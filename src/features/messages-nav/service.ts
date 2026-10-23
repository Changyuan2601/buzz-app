// Messages navigation views: alternative inventories for the primary sidebar.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType, ReactNode } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions.ts";
import type { OpenTarget } from "../navigation/targets";

/** Props for a view in the primary sidebar, below the shell's page navigation. */
export type MessagesNavProps = {
  /** The shell's current destination, for marking what is open. */
  target: OpenTarget;
};

export type MessagesNavView = Readonly<{
  id: string;
  title: string;
  icon?: ReactNode;
  /** Lower first; the bundled Messages view uses -100. */
  order?: number;
  component: ComponentType<MessagesNavProps>;
}>;
export type RegisteredMessagesNavView = Contribution<MessagesNavView>;
export type MessagesNavReader = {
  snapshot: () => readonly RegisteredMessagesNavView[];
  subscribe: (listener: () => void) => () => void;
};
export type MessagesNav = MessagesNavReader & {
  register(view: MessagesNavView): void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Absent on hosts before messages navigation views. */
    messagesNav: MessagesNav;
  }
}

export class MessagesNavService extends Service implements MessagesNav {
  private readonly contributions;
  private sorted: readonly RegisteredMessagesNavView[] = [];
  private source: readonly RegisteredMessagesNavView[] | undefined;
  constructor(ctx: Context) {
    super(ctx, "messagesNav");
    this.contributions = createContributions<MessagesNavView>(ctx);
  }
  snapshot = () => {
    const entries = this.contributions.snapshot();
    if (entries !== this.source) {
      this.source = entries;
      this.sorted = [...entries].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
      );
    }
    return this.sorted;
  };
  subscribe = (listener: () => void) => this.contributions.subscribe(listener);
  register(view: MessagesNavView) {
    if (
      !view ||
      typeof view.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(view.id) ||
      typeof view.title !== "string" ||
      !view.title.trim() ||
      typeof view.component !== "function" ||
      (view.order !== undefined && !Number.isFinite(view.order))
    )
      throw new Error(
        "A messages navigation view needs an id, a title, and a React component function",
      );
    this.contributions.register(this.ctx, view);
  }
}
