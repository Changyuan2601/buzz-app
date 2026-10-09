import { useEffect } from "react";
import type { PluginModule } from "../../plugins/api";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";

export const inject = ["pages", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const navigator = ctx.navigation;
  // Preserve old page links without retaining a second workspace.
  ctx.pages.register({
    id: "sessions",
    title: "Sessions (now in Me)",
    primary: false,
    component: ({ navigation }) => (
      <LegacySessions navigator={navigator} navigation={navigation} />
    ),
  });
};
function LegacySessions({
  navigator,
  navigation,
}: {
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
}) {
  useEffect(() => {
    if (!navigation || navigation.signal.aborted) return;
    const source = navigation.target;
    if (source.kind !== "page") return;
    void navigator.open(
      {
        version: 1,
        kind: "page",
        pluginId: "buzz.me",
        pageId: "me",
        ...(source.scope !== undefined ? { scope: source.scope } : {}),
      },
      { replace: true },
    );
  }, [navigator, navigation]);
  return <p role="status">Opening Me…</p>;
}
