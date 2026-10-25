import { createAppearance } from "./shared/theme/service";
import "./shared/design-system/styles/tokens.css";
import "../public/compute-widget.js";
import { attachUsbDisplay } from "../public/compute-widget-usb.js";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MenuIcon } from "./shared/design-system/icons";

const menu = document.getElementById("settings-toggle");
const usb = document.getElementById("usb-connect");
const status = document.getElementById("usb-status");
if (menu && usb instanceof HTMLButtonElement && status) {
  createRoot(menu).render(createElement(MenuIcon, { size: 16 }));
  attachUsbDisplay(usb, status);
}

const appearance = createAppearance();
window.addEventListener("pagehide", () => appearance.dispose(), { once: true });
