// FOUNDATION: React startup. Keep initialization explicit and minimal.
// Establish host CSS layer order before product modules import component layers.
import "./shared/styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createServices } from "./app/services";
import { App } from "./app/App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import { useKeyboardFocusVisibility } from "./shared/design-system/useKeyboardFocusVisibility";
import { useRejectUnclaimedDrops } from "./features/messages/use-file-drop";

const container = document.getElementById("root");

if (!container) {
  throw new Error('Missing <div id="root"> in index.html');
}

const services = createServices();
const root = createRoot(container);
function HostApp() {
  useKeyboardFocusVisibility();
  useRejectUnclaimedDrops();
  return <App services={services} />;
}
root.render(
  <StrictMode>
    <HostApp />
  </StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    root.unmount();
    void services.dispose().catch(console.error);
  });
}
