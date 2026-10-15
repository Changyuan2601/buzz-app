// Match the app entry: establish reset and layer order before component CSS.
import "../../../src/shared/styles/globals.css";
import "../../../src/bundled/workflows/workflows.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { Scene } from "./Scene";
import { dialogs, type DialogId } from "./catalog";
import { installCommunityFixture } from "./data";
import "./styles.css";

const params = new URLSearchParams(location.search);
const scene = dialogs.find((dialog) => dialog.id === params.get("scene"));
const groups = [...new Set(dialogs.map((dialog) => dialog.group))];
const urlFor = (
  id: DialogId,
  theme: string,
  scale = "100",
  variant = "default",
) => `?scene=${id}&theme=${theme}&scale=${scale}&variant=${variant}`;

function Preview({ id, theme }: { id: DialogId; theme: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / 1100);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="atlas-preview" ref={ref} style={{ height: 780 * scale }}>
      <iframe
        title={`${id} visual preview`}
        src={urlFor(id, theme)}
        tabIndex={-1}
        aria-hidden="true"
        loading="lazy"
        style={{ width: 1100, height: 780, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function Gallery() {
  const [theme, setTheme] = useState("light");
  const [filter, setFilter] = useState("All dialogs");
  const [selected, setSelected] = useState<(typeof dialogs)[number] | null>(
    null,
  );
  const [width, setWidth] = useState("full");
  const [scale, setScale] = useState("100");
  const [variant, setVariant] = useState("default");
  const [revision, setRevision] = useState(0);
  const inspector = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    document.documentElement.dataset.colorMode = theme;
  }, [theme]);
  useEffect(() => {
    if (selected) inspector.current?.showModal();
    else inspector.current?.close();
  }, [selected]);
  const visible = dialogs.filter(
    (dialog) => filter === "All dialogs" || dialog.group === filter,
  );
  return (
    <main className="atlas" data-buzz-ui="">
      <header className="atlas-header">
        <div>
          <p className="atlas-eyebrow">BUZZ / POLISH INVENTORY / 01</p>
          <h1>Dialog atlas</h1>
          <p className="atlas-intro">
            Every modal, in context. An inventory of the current app, rendered
            with its real components.
          </p>
        </div>
        <div className="atlas-theme">
          <Button
            size="sm"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? "Switch to dark" : "Switch to light"}
          </Button>
        </div>
      </header>
      <div className="atlas-summary">
        <strong>12 places</strong>
        <span>8 implementations</span>
        <span>4 families</span>
        <span>Live components · local sample data</span>
      </div>
      <nav className="atlas-filters" aria-label="Dialog families">
        {["All dialogs", ...groups].map((group) => (
          <Button
            key={group}
            size="sm"
            variant={filter === group ? "prominent" : "ghost"}
            aria-pressed={filter === group}
            onClick={() => setFilter(group)}
          >
            {group}
          </Button>
        ))}
      </nav>
      <div className="atlas-grid">
        {visible.map((dialog) => (
          <article className="atlas-card" key={dialog.id}>
            <button
              type="button"
              className="atlas-open"
              aria-label={`Inspect ${dialog.name}`}
              onClick={() => {
                setSelected(dialog);
                setVariant("default");
                setRevision(0);
              }}
            >
              <Preview id={dialog.id} theme={theme} />
              <span className="atlas-open-label">
                Open interactive preview ↗
              </span>
            </button>
            <div className="atlas-card-copy">
              <p className="atlas-kicker">
                {dialog.group}
                <span>
                  {String(dialogs.indexOf(dialog) + 1).padStart(2, "0")}
                </span>
              </p>
              <h2>{dialog.name}</h2>
              <p className="atlas-path">{dialog.path}</p>
              <p className="atlas-note">{dialog.note}</p>
              <div className="atlas-source">
                <strong>{dialog.frame}</strong>
                <code>{dialog.source}</code>
              </div>
            </div>
          </article>
        ))}
      </div>
      <footer className="atlas-footnote">
        Current implementation, not proposed redesigns. Thumbnail previews use a
        1100 × 780 viewport. Open a dialog to inspect actual size, narrow
        layouts, and enlarged text. The background is a simplified context;
        dialog markup and styles are the production components. Workflow copy is
        captured from its current callers.
      </footer>
      <dialog
        ref={inspector}
        className="atlas-inspector"
        aria-labelledby="inspector-title"
        onCancel={() => setSelected(null)}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <>
            <header className="inspector-header">
              <div>
                <p className="atlas-eyebrow">{selected.group}</p>
                <h2 id="inspector-title">{selected.name}</h2>
                <p>{selected.path}</p>
              </div>
              <Button onClick={() => setSelected(null)}>Close inspector</Button>
            </header>
            <div className="inspector-tools">
              <label>
                Viewport{" "}
                <select
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                >
                  <option value="full">Fill window</option>
                  <option value="768">768px</option>
                  <option value="390">390px</option>
                </select>
              </label>
              <label>
                Text{" "}
                <select
                  value={scale}
                  onChange={(event) => setScale(event.target.value)}
                >
                  <option value="100">100%</option>
                  <option value="150">150%</option>
                  <option value="200">200%</option>
                </select>
              </label>
              <label>
                Theme{" "}
                <select
                  value={theme}
                  onChange={(event) => setTheme(event.target.value)}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              {(selected.id === "enable" ||
                selected.id === "dismiss" ||
                selected.id === "webhook") && (
                <label>
                  State{" "}
                  <select
                    value={variant}
                    onChange={(event) => setVariant(event.target.value)}
                  >
                    <option value="default">Default</option>
                    {selected.id === "enable" ? (
                      <>
                        <option value="schedule">Scheduled trigger</option>
                        <option value="message">Every message</option>
                      </>
                    ) : selected.id === "webhook" ? (
                      <option value="noaddress">No relay address</option>
                    ) : (
                      <>
                        <option value="pending">Pending</option>
                        <option value="error">Error</option>
                      </>
                    )}
                  </select>
                </label>
              )}
              <Button
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                Reset preview
              </Button>
              <a
                href={urlFor(selected.id, theme, scale, variant)}
                target="_blank"
                rel="noreferrer"
              >
                Open full window ↗
              </a>
            </div>
            <div className="inspector-stage">
              <iframe
                key={`${selected.id}-${revision}`}
                title={`${selected.name} interactive preview`}
                src={urlFor(selected.id, theme, scale, variant)}
                style={{ width: width === "full" ? "100%" : `${width}px` }}
              />
            </div>
            <p className="inspector-note">
              {selected.note} <code>{selected.source}</code>
            </p>
          </>
        )}
      </dialog>
    </main>
  );
}

if (scene) {
  installCommunityFixture();
  document.documentElement.dataset.colorMode =
    params.get("theme") === "dark" ? "dark" : "light";
  document.documentElement.style.setProperty(
    "--buzz-text-scale",
    String(Number(params.get("scale") ?? 100) / 100),
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing gallery root");
const reactRoot = createRoot(root);
reactRoot.render(scene ? <Scene id={scene.id} /> : <Gallery />);
if (import.meta.hot) import.meta.hot.dispose(() => reactRoot.unmount());
