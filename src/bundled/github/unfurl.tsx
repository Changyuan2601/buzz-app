import { useState, useEffect } from "react";
import { GithubLogoIcon } from "../../shared/design-system/icons/index";
import { parseGitHubReference } from "./references";
import { GhUnavailable, type GitHubCli } from "./gh";
import styles from "../../shared/InlineReference.module.css";

type UnfurlResult = { title: string };

const cache = new Map<string, Promise<UnfurlResult | undefined>>();

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
  issueOrPullRequest(number:$number){... on Issue{title}... on PullRequest{title}}}}`;

type Response = {
  repository: {
    issueOrPullRequest?: { title: string } | null;
  } | null;
};

function fetchTitle(
  url: string,
  gh: GitHubCli | undefined,
): Promise<UnfurlResult | undefined> {
  const ref = parseGitHubReference(url);
  if (!ref || (ref.kind !== "pull" && ref.kind !== "issue"))
    return Promise.resolve(undefined);

  const key = ref.url;
  const hit = cache.get(key);
  if (hit) return hit;

  const [owner, name] = ref.repository.split("/");
  const number = Number(ref.label.slice(1));

  const work = (async (): Promise<UnfurlResult | undefined> => {
    if (gh) {
      try {
        const data = await gh<Response>(QUERY, { owner, name, number });
        const item = data.repository?.issueOrPullRequest;
        if (item?.title) return { title: item.title };
        return undefined;
      } catch (error) {
        if (!(error instanceof GhUnavailable)) return undefined;
      }
    }
    try {
      const surface = ref.kind === "pull" ? "pulls" : "issues";
      const res = await fetch(
        `https://api.github.com/repos/${ref.repository}/${surface}/${number}`,
        { credentials: "omit" },
      );
      if (!res.ok) return undefined;
      const data: { title?: string } = await res.json();
      return data.title ? { title: data.title } : undefined;
    } catch {
      return undefined;
    }
  })();

  cache.set(key, work);
  return work;
}

export function unfurlMatches(url: string): boolean {
  const ref = parseGitHubReference(url);
  return ref?.kind === "pull" || ref?.kind === "issue";
}

export function createUnfurlComponent(gh: GitHubCli | undefined) {
  return function GitHubUnfurl({ url }: { url: string }) {
    const ref = parseGitHubReference(url);
    const label = ref ? `${ref.repository}${ref.label}` : url;
    const [title, setTitle] = useState<string | undefined>();

    useEffect(() => {
      let cancelled = false;
      fetchTitle(url, gh).then((result) => {
        if (!cancelled && result) setTitle(result.title);
      });
      return () => {
        cancelled = true;
      };
    }, [url]);

    const text = title ? `${label} · ${title}` : label;
    return (
      <span data-link-kind="github">
        <span className={styles.lead}>
          <GithubLogoIcon aria-hidden="true" className={styles.icon} />
          {text.charAt(0)}
        </span>
        {text.slice(1)}
      </span>
    );
  };
}

/** @internal Clear the cache between tests. */
export function _clearCache() {
  cache.clear();
}
