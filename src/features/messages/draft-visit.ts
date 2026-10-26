import { useEffect } from "react";
import type { PageNavigation } from "../navigation/service";
import { readView } from "../../shared/view-state";
import { attachmentDraftCount } from "./attachment-draft";
import type { ComposerSession } from "./composer-session";
import { hasDraftContent, mentionDraft } from "./mention-draft";

/** A new conversation's visit is a Back stop only once its composer draft
 * holds something the person wrote; until then the next page replaces it. */
export function usePassThroughUntilDrafted(
  visit: PageNavigation | undefined,
  session: ComposerSession,
  scope: string,
  draftKey: string,
) {
  useEffect(
    () =>
      visit?.passThrough(
        () =>
          !hasDraftContent(
            mentionDraft(readView<unknown>(scope, draftKey, "")),
            attachmentDraftCount(session, `${scope}:${draftKey}`),
          ),
      ),
    [visit, session, scope, draftKey],
  );
}
