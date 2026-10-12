import { createAppearance } from "./shared/theme/service";
import "./shared/design-system/styles/tokens.css";
import "../public/compute-widget.js";

const appearance = createAppearance();
window.addEventListener("pagehide", () => appearance.dispose(), { once: true });
