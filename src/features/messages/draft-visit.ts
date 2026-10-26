import { useEffect } from "react";
import type { PageNavigation } from "../navigation/service";
import { readView } from "../../shared/view-state";
import { attachmentDraftCount } from "./attachment-draft";
import type { ComposerSession } from "./composer-session";
import {
  hasDraftContent,
  mentionDraft,
  type MentionDraft,
} from "./mention-draft";

/** A new conversation's visit is a Back stop only once its composer draft
 * holds something the person wrote; until then the next page replaces it.
 * `initialDraft` reads what the composer shows while nothing is saved. */
export function usePassThroughUntilDrafted(
  visit: PageNavigation | undefined,
  session: ComposerSession,
  scope: string,
  draftKey: string,
  initialDraft?: () => MentionDraft | string | undefined,
) {
  useEffect(
    () =>
      visit?.passThrough(
        () =>
          !hasDraftContent(
            mentionDraft(
              readView<unknown>(scope, draftKey, initialDraft?.() ?? ""),
            ),
            attachmentDraftCount(session, `${scope}:${draftKey}`),
          ),
      ),
    [visit, session, scope, draftKey, initialDraft],
  );
}
