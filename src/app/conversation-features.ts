import type { BundledPlugin } from "../plugins/manager";
import emojiManifest from "../bundled/emoji/manifest.json";
import * as emoji from "../bundled/emoji";
import mentionsManifest from "../bundled/mentions/manifest.json";
import * as mentions from "../bundled/mentions";

import mainAgentManifest from "../bundled/bestie/manifest.json";
import * as mainAgent from "../bundled/bestie";

// Host-owned features use the shared contribution lifecycle, without catalog
// entries or saved enablement. Keep their keys for composer and huddle consumers.
export const conversationFeatures: readonly BundledPlugin[] = [
  { manifest: { ...emojiManifest, apiVersion: 1 }, module: emoji },
  { manifest: { ...mentionsManifest, apiVersion: 1 }, module: mentions },
  // Preserve the page key; saved experimental flags no longer govern this destination.
  { manifest: { ...mainAgentManifest, apiVersion: 1 }, module: mainAgent },
];
