// Optional presentation only. The session owns accepted setup and delivery.
import { Service, type Context } from "@deepseek-ai/cordis";
import type { ComponentType, ReactNode, RefObject } from "react";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import type { AgentControl } from "../agents/control";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { Group, KitEntry, Lineup } from "./model";
export type TemplateDraft = {
  templateId: string;
  lineup: Lineup;
  agents: string[];
  problem?: string | undefined;
};
export type TemplateEditorProps = {
  session: RelaySession;
  value: TemplateDraft | undefined;
  initialDefault: string;
  group: Group | undefined;
  onChange(value: TemplateDraft): void;
  active(): boolean;
};
export type GroupDefaultProps = {
  value: string;
  entries: readonly KitEntry[];
  onChange(value: string): void;
  active(): boolean;
};
export type SaveTemplateProps = {
  menu?: {
    close(): void;
    finalFocus: RefObject<HTMLButtonElement | null>;
    render(items: ReactNode): ReactNode;
  };
  session: RelaySession;
  channel: ChannelSummary;
  active(): boolean;
};
export type TemplateProvider = {
  id: string;
  title: string;
  editor: ComponentType<TemplateEditorProps>;
  groupDefault: ComponentType<GroupDefaultProps>;
  saveAs: ComponentType<SaveTemplateProps>;
  teams?: ComponentType<{
    session: RelaySession;
    control?: AgentControl | undefined;
    active(): boolean;
  }>;
};
export type TemplateProviders = {
  snapshot(): readonly Contribution<TemplateProvider>[];
  subscribe(listener: () => void): () => void;
  register(provider: TemplateProvider): void;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    channelTemplates: TemplateProviders;
  }
}
export class TemplateProvidersService
  extends Service
  implements TemplateProviders
{
  private readonly entries;
  constructor(ctx: Context) {
    super(ctx, "channelTemplates");
    this.entries = createContributions<TemplateProvider>(ctx);
  }
  snapshot = () => this.entries.snapshot();
  subscribe = (listener: () => void) => this.entries.subscribe(listener);
  register(provider: TemplateProvider) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(provider.id) ||
      !provider.title?.trim() ||
      [provider.editor, provider.groupDefault, provider.saveAs].some(
        (c) => typeof c !== "function",
      )
    )
      throw new Error(
        "Template provider needs an id, title and editor components",
      );
    this.entries.register(this.ctx, provider);
  }
}
