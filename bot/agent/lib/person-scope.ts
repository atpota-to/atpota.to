/**
 * The scope of someone's person notes, the same wherever Poe meets them.
 *
 * Bluesky turns resolve it with eve's byPrincipal, which puts the
 * authenticator in the key: [["user","atpotato-droplet",null,<did>] as JSON,
 * <did>]. A visitor signed in on atpota.to arrives under the website's own
 * authenticator, so byPrincipal would hand them a second, empty document and
 * Poe would meet the same person as a stranger. This spells out the Bluesky
 * key instead, so a website turn reads and writes the notes Poe already keeps,
 * and the notes it saves there are published like any other.
 * tests/person-scope.test.mjs holds it to eve's own byPrincipal.
 *
 * Only call it with a DID a trusted caller asserted: the droplet off a signed
 * post, or the website proxy off a verified service-auth token.
 */
export function personScope(did: string): [string, string] {
  return [JSON.stringify(["user", "atpotato-droplet", null, did]), did];
}
