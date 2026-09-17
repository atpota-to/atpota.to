---
description: Use when someone asks who linked to, replied to, quoted, liked, or otherwise referenced a record, especially across different apps rather than only within Bluesky.
---

# Backlinks

`get_backlinks` answers a question most people have never been able to ask: who
pointed at this thing, from anywhere in the network, not just from the app you
are looking at.

## Procedure

1. Resolve the subject to an `at://` URI first. Backlinks are keyed on the URI,
   so an unresolved handle gets you nothing.
2. `get_backlinks`.
3. Group the results by collection, not by account. The interesting structure is
   "eleven likes, three quotes, and one record from an app you have not heard of."
4. Resolve anything surprising. A backlink from a non-Bluesky collection is the
   headline, so `resolve_link` it and say what the app is.
5. Give them the aturi.to link for the subject so they can keep exploring.

## Framing it for someone who has not seen this before

One sentence, no lecture: in the Atmosphere, a like or a reply is just a record
in someone else's repository pointing at yours, so you can ask who is pointing at
a thing regardless of which app they used. Then show them.

## Rules

- Empty is a real answer and a common one. Say nothing links to it yet.
- Backlink indexes are not guaranteed complete. Say "these are the ones I can
  see," not "these are all of them."
- Do not turn a backlink list into a profile of every account that engaged. Report
  the shape, name what is notable, stop.
