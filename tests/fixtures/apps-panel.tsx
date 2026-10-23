import "../../src/shared/styles/globals.css";
import { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyApps } from "../../src/bundled/builderlab/apps";
import { createOAuthSession } from "../../src/bundled/builderlab/oauth/session";
import { BrowserService } from "../../src/features/browser/service";
import type { BrowserPlatform } from "../../src/features/browser/platform";
import { PanelsService } from "../../src/features/panels/service";

// The native adapter is substituted; Cordis, plugin registration, React view
// identity and the four-guest pool are the production collaborators.
const calls = {
  attached: [] as { id: string; url: string }[],
  detached: [] as string[],
  statuses: [] as { id: string; url: string }[],
};
Object.assign(window, { appsPanelCalls: calls });
const pages = new Map<string, string>();
const platform: BrowserPlatform = {
  available: true,
  async attach(url) {
    const id = `guest-${calls.attached.length + 1}`;
    calls.attached.push({ id, url });
    pages.set(id, url);
    return id;
  },
  async setBounds() {},
  async navigate(id, url) {
    pages.set(id, url);
  },
  async action() {},
  async status(id) {
    const url = pages.get(id) ?? "";
    calls.statuses.push({ id, url });
    return { url, title: "", loading: false, error: null };
  },
  async detach(id) {
    calls.detached.push(id);
    pages.delete(id);
  },
};
const ctx = new Context();
ctx.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
ctx.provide("agents", { addTool() {} });
new BrowserService(ctx, platform);
const panels = new PanelsService(ctx);
applyApps(
  ctx.extend({ pluginOwner: { id: "fixture.apps", revision: "one" } }) as never,
  createOAuthSession(async () => {
    throw new Error("Sign-in is unused in this fixture");
  }),
);
const urls = [1, 2, 3, 4, 5].map(
  (id) => `https://app${id}--bpsites.apps.builderlabstaging.xyz/`,
);
const app = panels.resolve(urls[0] ?? "");
if (!app) throw new Error("App panel did not register");
const AppView = app.component;
function Apps() {
  const [selected, select] = useState(0);
  return (
    <>
      {urls.map((url, index) => (
        <button key={url} type="button" onClick={() => select(index)}>
          Show app {index + 1}
        </button>
      ))}
      <div style={{ position: "relative", height: 400, width: 800 }}>
        {urls.map((url, index) => (
          <section
            key={url}
            aria-label={`App ${index + 1} pane`}
            data-covered={selected === index ? undefined : ""}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              visibility: selected === index ? "visible" : "hidden",
            }}
          >
            <AppView target={url} close={() => {}} />
          </section>
        ))}
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<Apps />);
