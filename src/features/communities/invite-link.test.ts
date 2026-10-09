import { expect, it } from "vitest";
import { parseInviteLink } from "./invite-link";

it.each(["", "/"])(
  "parses the join form with path %j and canonicalizes the relay",
  (path) => {
    expect(
      parseInviteLink(
        `buzz://join${path}?relay=wss%3A%2F%2Frelay.example%2F&code=v2.invite&policy_receipt=receipt`,
      ),
    ).toEqual({
      community: "https://relay.example",
      code: "v2.invite",
    });
  },
);
it.each([
  "buzz://join?relay=example&code=x",
  "buzz://join?relay=ws%3A%2F%2Frelay.example&code=x",
  "buzz://join?relay=wss%3A%2F%2Fuser%40relay.example&code=x",
  "buzz://join?relay=wss%3A%2F%2Frelay.example%2Fother&code=x",
  "buzz://join?relay=wss%3A%2F%2Frelay.example&code=",
  "buzz://join?relay=wss%3A%2F%2Frelay.example&code=x&code=y",
  "buzz://join?relay=wss%3A%2F%2Frelay.example&code=x#fragment",
  "https://relay.example/invite/x?redirect=evil",
])("rejects an unsafe or ambiguous invite: %s", (url) => {
  expect(parseInviteLink(url)).toBeNull();
});

it.each(["", "/"])("keeps invite validation with path %j", (path) => {
  const query = "relay=wss%3A%2F%2Frelay.example&code=v2.invite";
  for (const url of [
    `buzz://join${path}?${query}&code=other`,
    `buzz://join${path}?${query}&relay=wss%3A%2F%2Fother.example`,
    `buzz://join${path}?${query}&policy_receipt=`,
    `buzz://join${path}?${query}&policy_receipt=x&policy_receipt=y`,
    `buzz://join${path}?${query}#fragment`,
    `buzz://join:443${path}?${query}`,
    `buzz://user@join${path}?${query}`,
    `buzz://join${path}?relay=ws%3A%2F%2Frelay.example&code=x`,
    `buzz://join${path}?relay=wss%3A%2F%2Frelay.example&code=`,
  ])
    expect(parseInviteLink(url), url).toBeNull();
});
it.each(["//", "/extra", "/%2F", "/./", "/extra/.."])(
  "rejects noncanonical invite path %j",
  (path) => {
    expect(
      parseInviteLink(
        `buzz://join${path}?relay=wss%3A%2F%2Frelay.example&code=x`,
      ),
    ).toBeNull();
  },
);
