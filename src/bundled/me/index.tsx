import type { PluginModule } from "../../plugins/api";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "me",
    title: "Me",
    primary: true,
    placement: "topbar",
    component: MePage,
  });
};

function MePage() {
  return <h1>Me</h1>;
}
