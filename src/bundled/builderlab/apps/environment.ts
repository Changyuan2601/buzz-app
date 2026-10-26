// Which Apps Platform a Builderlab sign-in deploys to: the control plane of
// the same tenant, since its session is only valid there. Kept in step with
// `apps_control_plane` in crates/plugin-manager, which grants the plugin that
// origin.
const CONTROL_PLANES: Readonly<Record<string, string>> = {
  "https://app.builderlab.xyz": "https://compose-ctrl.public.builderlab.xyz",
  "https://app.builderlabstaging.xyz":
    "https://compose-ctrl.apps.builderlabstaging.xyz",
  "https://block.builderlab.xyz": "https://compose-ctrl.block.builderlab.xyz",
};

/** The control plane for the configured Builderlab URL, if it has one. */
export function controlPlane(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  try {
    return CONTROL_PLANES[new URL(value).origin];
  } catch {
    return undefined;
  }
}

/** Hosts that serve deployed apps, a subdomain each, per tenant. */
const APP_DOMAINS = [
  "apps.builderlab.xyz",
  "apps.public.builderlab.xyz",
  "apps.builderlabstaging.xyz",
  "apps.block.builderlab.xyz",
  "apps.test.blockstaging.build",
];

/** An app's name from its host, `<name>--<workspace>.<apps domain>`. */
export function appName(target: string) {
  try {
    return new URL(target).hostname.split(".")[0]?.split("--")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Whether `target` is a deployed app's page. */
export function isAppUrl(target: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    APP_DOMAINS.some((domain) => host.endsWith(`.${domain}`))
  );
}

/** A credential is only exchanged for app hosts in the same configured tenant. */
export function isViewerTarget(
  target: string,
  origin = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  const domains: Readonly<Record<string, string>> = {
    "https://app.builderlab.xyz": "apps.builderlab.xyz",
    "https://app.builderlabstaging.xyz": "apps.builderlabstaging.xyz",
    "https://block.builderlab.xyz": "apps.block.builderlab.xyz",
  };
  try {
    const url = new URL(target);
    const domain = domains[new URL(origin).origin];
    const label = domain && url.hostname.slice(0, -(domain.length + 1));
    return (
      isAppUrl(target) &&
      Boolean(
        domain &&
          url.port === "" &&
          url.hostname.endsWith(`.${domain}`) &&
          label &&
          !label.includes(".") &&
          label !== "login" &&
          label !== "health",
      )
    );
  } catch {
    return false;
  }
}
