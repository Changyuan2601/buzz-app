import voiceNotesManifest from "./voice-notes/manifest.json";
import * as voiceNotes from "./voice-notes";
import pairingManifest from "./pairing/manifest.json";
import todosManifest from "./todos/manifest.json";
import huddlesManifest from "./huddles/manifest.json";
import * as huddles from "./huddles";
import builderlabManifest from "./builderlab/manifest.json";
import * as builderlab from "./builderlab";
import * as todos from "./todos";
import diffsManifest from "./diffs/manifest.json";
import * as diffs from "./diffs";
import mermaidManifest from "./mermaid/manifest.json";
import * as mermaid from "./mermaid";
import namingManifest from "./identity-naming/manifest.json";
import * as naming from "./identity-naming";
import feedbackManifest from "./feedback/manifest.json";
import activityManifest from "./agent-activity/manifest.json";
import * as activity from "./agent-activity";
import terminalManifest from "./terminal/manifest.json";
import * as terminal from "./terminal";
import profilesManifest from "./profiles/manifest.json";
import * as profiles from "./profiles";
import agentsManifest from "./agents/manifest.json";
import * as agents from "./agents";
import claudeCodeManifest from "./claude-code/manifest.json";
import * as claudeCode from "./claude-code";
import codexManifest from "./codex/manifest.json";
import * as codex from "./codex";
import gooseManifest from "./goose/manifest.json";
import * as goose from "./goose";
import piManifest from "./pi/manifest.json";
import * as pi from "./pi";
import channelsManifest from "./channels/manifest.json";
import githubManifest from "./github/manifest.json";
import * as channels from "./channels";
import * as github from "./github";
import bestieManifest from "./bestie/manifest.json";
import * as bestie from "./bestie";
import usageManifest from "./usage/manifest.json";
import * as usage from "./usage";
import inboxManifest from "./inbox/manifest.json";
import * as inbox from "./inbox";
import remindersManifest from "./reminders/manifest.json";
import * as reminders from "./reminders";
import reposManifest from "./repos/manifest.json";
import * as repos from "./repos";
import workflowsManifest from "./workflows/manifest.json";
import * as workflows from "./workflows";
import type { BundledPlugin } from "../plugins/manager";
import { afterFirstView } from "../plugins/startup";
import linksManifest from "./links/manifest.json";
import * as links from "./links";
import hostedManifest from "./hosted-communities/manifest.json";
import moderationManifest from "./moderation/manifest.json";
import relayStaffManifest from "./relay-staff/manifest.json";
import typesafeManifest from "./typesafe/manifest.json";

import relayNotesManifest from "./relay-notes/manifest.json";
import * as relayNotes from "./relay-notes";

export const bundledPlugins: readonly BundledPlugin[] = [
  {
    manifest: { ...relayNotesManifest, apiVersion: 1 },
    module: relayNotes,
    enabledByDefault: false,
  },
  {
    manifest: { ...huddlesManifest, apiVersion: 1 },
    module: huddles,
    enabledByDefault: true,
  },
  {
    manifest: { ...voiceNotesManifest, apiVersion: 1 },
    module: voiceNotes,
    enabledByDefault: true,
  },
  {
    manifest: { ...builderlabManifest, apiVersion: 1 },
    module: builderlab,
    enabledByDefault: true,
  },
  {
    manifest: { ...pairingManifest, apiVersion: 1 },
    module: afterFirstView(() => import("./pairing")),
    enabledByDefault: true,
  },
  {
    manifest: { ...feedbackManifest, apiVersion: 1 },
    module: afterFirstView(() => import("./feedback")),
    enabledByDefault: true,
  },
  {
    manifest: { ...todosManifest, apiVersion: 1 },
    module: todos,
    enabledByDefault: false,
  },
  {
    manifest: { ...diffsManifest, apiVersion: 1 },
    module: diffs,
    enabledByDefault: true,
  },
  {
    manifest: { ...mermaidManifest, apiVersion: 1 },
    module: mermaid,
    enabledByDefault: true,
  },
  {
    manifest: { ...namingManifest, apiVersion: 1 },
    module: naming,
    enabledByDefault: true,
  },
  {
    manifest: { ...activityManifest, apiVersion: 1 },
    module: activity,
    enabledByDefault: true,
  },
  {
    manifest: { ...terminalManifest, apiVersion: 1 },
    module: terminal,
    enabledByDefault: true,
  },
  {
    manifest: { ...profilesManifest, apiVersion: 1 },
    module: profiles,
    enabledByDefault: true,
  },
  {
    manifest: { ...linksManifest, apiVersion: 1 },
    module: links,
    enabledByDefault: true,
  },
  {
    manifest: { ...channelsManifest, apiVersion: 1 },
    module: channels,
    enabledByDefault: true,
  },
  {
    manifest: { ...githubManifest, apiVersion: 1 },
    module: github,
    enabledByDefault: true,
  },
  {
    manifest: { ...bestieManifest, apiVersion: 1 },
    module: bestie,
    enabledByDefault: false,
  },
  {
    manifest: { ...usageManifest, apiVersion: 1 },
    module: usage,
    enabledByDefault: false,
  },
  {
    manifest: { ...inboxManifest, apiVersion: 1 },
    module: inbox,
    enabledByDefault: true,
  },
  {
    manifest: { ...remindersManifest, apiVersion: 1 },
    module: reminders,
    enabledByDefault: true,
  },
  {
    manifest: { ...reposManifest, apiVersion: 1 },
    module: repos,
    enabledByDefault: true,
  },
  {
    manifest: { ...agentsManifest, apiVersion: 1 },
    module: agents,
    enabledByDefault: true,
  },
  {
    manifest: { ...claudeCodeManifest, apiVersion: 1 },
    module: claudeCode,
    enabledByDefault: true,
  },
  {
    manifest: { ...codexManifest, apiVersion: 1 },
    module: codex,
    enabledByDefault: true,
  },
  {
    manifest: { ...gooseManifest, apiVersion: 1 },
    module: goose,
    enabledByDefault: true,
  },
  {
    manifest: { ...piManifest, apiVersion: 1 },
    module: pi,
    enabledByDefault: false,
  },
  {
    manifest: { ...workflowsManifest, apiVersion: 1 },
    module: workflows,
    enabledByDefault: true,
  },
  {
    manifest: { ...hostedManifest, apiVersion: 1 },
    module: afterFirstView(() => import("./hosted-communities")),
    enabledByDefault: true,
  },
  {
    manifest: { ...moderationManifest, apiVersion: 1 },
    module: afterFirstView(() => import("./moderation")),
    enabledByDefault: true,
  },
  {
    manifest: { ...relayStaffManifest, apiVersion: 1 },
    module: afterFirstView(() => import("./relay-staff")),
    enabledByDefault: true,
  },
  {
    manifest: { ...typesafeManifest, apiVersion: 1 },
    module: afterFirstView(() => import("./typesafe")),
    enabledByDefault: true,
  },
];
