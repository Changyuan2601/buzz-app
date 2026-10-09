import type { PluginModule } from "../../plugins/api";
import { LinkLabel, linkKind } from "./InlineLink";
import styles from "../../shared/InlineReference.module.css";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerLink({
    id: "links",
    title: "Links",
    matches: (url) => linkKind(url) !== null,
    // Specific for recognised services and Buzz entities; a catch-all for the
    // globe case, so a dedicated renderer wins unknown hosts at the default band.
    order: (url) => (linkKind(url) === "web" ? 100 : 0),
    className: styles.link,
    component: ({ url }) => <LinkLabel href={url} />,
  });
};
