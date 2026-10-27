import "../../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GitHubPanel } from "../../../src/bundled/github";
import {
  GhUnavailable,
  parseAnswer,
  type GitHubCli,
} from "../../../src/bundled/github/gh";
import { PanelCard } from "../../../src/features/panels/PanelCard";
import type { RegisteredPanel } from "../../../src/features/panels/service";

const signed =
  new URLSearchParams(location.search).get("transport") === "signed";
// Only the external CLI is replaced. The production GraphQL envelope parser,
// PR parser, REST loader, checklist, Markdown and React lifecycle still run.
const gh: GitHubCli = async <T,>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  if (!signed) throw new GhUnavailable("Benchmark signed out");
  const response = await fetch("/__github/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    signal: signal ?? null,
  });
  return parseAnswer<T>(await response.text(), "", response.ok ? 0 : 1);
};
const panel: RegisteredPanel = {
  id: "github",
  key: "github:benchmark",
  pluginId: "github",
  revision: "1",
  title: "GitHub",
  matches: () => true,
  component: (props) => <GitHubPanel {...props} gh={gh} />,
};
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main style={{ padding: 24 }}>
      <button type="button" id="open-pr" onClick={() => setOpen(true)}>
        Open benchmark PR
      </button>
      <div style={{ width: 680, height: 840, marginTop: 12 }}>
        {open && (
          <PanelCard
            panel={panel}
            target="https://github.com/sample/project/pull/9"
            close={() => setOpen(false)}
          />
        )}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
