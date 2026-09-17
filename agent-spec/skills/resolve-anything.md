---
description: Use when the visitor pastes or names any Atmosphere identifier (a handle, DID, at:// URI, aturi.to link, record key, NSID, or CID) and wants to know what it is or what it points at.
---

# Resolving anything

People paste things without knowing what they pasted. Work out what it is before
you do anything else.

## Identifier taxonomy

| Looks like | It is | Start with |
| --- | --- | --- |
| `name.bsky.social`, `dame.art`, any domain | A handle. Mutable, can be reassigned | `resolve_identity` |
| `did:plc:6teuh…` | A PLC DID. Permanent, the real identity | `resolve_identity` |
| `did:web:example.com` | A DID hosted on a domain | `resolve_identity` |
| `at://did:plc:…/collection/rkey` | A specific record | `resolve_link` |
| `at://did:plc:…/collection` | A whole collection in a repo | `list_records` |
| `aturi.to/handle/collection/rkey` | A universal link wrapping the above | `resolve_link` |
| `3mtkpzxkh5k2e` alone | A record key with no repo. Ambiguous, ask which account | Ask first |
| `app.bsky.feed.post`, `sh.tangled.repo` | An NSID, a record type | `search_lexicons` then `get_lexicon_schema` |
| `bafyrei…` | A CID, a content hash | Say what it is; you cannot resolve it directly |
| A bsky.app or other client URL | A client's view of a record | `resolve_link` |

## Procedure

1. Classify it. If you cannot, say what it resembles and ask one question.
2. Resolve it. A handle is not an answer, the DID behind it is.
3. Say what it is in one sentence, in terms the visitor will recognize. "A
   Bluesky post" beats "an `app.bsky.feed.post` record" unless they are clearly
   technical, in which case give both.
4. Say who owns it, using the current handle and noting the DID.
5. Offer the next step that fits: open it, see what links to it, see what else is
   in the repo.
6. Close with an aturi.to universal link.

## Things to get right

- Handle and DID are not interchangeable. If a handle resolved to a DID, the DID
  is the fact and the handle is the current label.
- A collection NSID tells you which app is involved. `app.bsky.*` is Bluesky,
  and anything else is worth naming (`sh.tangled.*`, `blue.flashes.*`,
  `pub.leaflet.*`, and so on). Confirm with `search_lexicons` rather than
  assuming from the domain shape.
- If the record does not exist, say whether the repo exists. "That account is
  there, that record is not" is a different answer from "that account is gone."
- Deleted and never-existed look the same from outside. Do not claim to know
  which.
