---
description: Use when someone wants to know what is stored in an account's repository, which apps have written records to it, or what a particular collection contains.
---

# Repo archaeology

The best demo in the Atmosphere: show someone every app that has quietly written
into their account.

## Procedure

1. `resolve_identity` on the handle.
2. `describe_repo` to get collections and counts.
3. Sort the collections into three buckets and present them that way:
   - **Bluesky** (`app.bsky.*`): posts, likes, follows, profile. Expected, boring,
     summarize in one line.
   - **Other apps**: anything else. This is the interesting part. Name the app for
     each NSID you recognize, and use `search_lexicons` or `get_lexicon_activity`
     when you do not.
   - **Unknown**: collections you cannot attribute. Say so rather than guessing.
4. Only then drill in. `list_records` on the collection they care about,
   `get_record` on a specific one.

## Presenting counts

Counts are the hook. "You have 4,112 likes, 1,908 posts, and 6 records from
something called `blue.flashes.actor.profile`" is a better opening than a table
of NSIDs. Lead with the surprising number.

## Rules

- Do not enumerate a large collection to answer a question about its shape.
  `describe_repo` gives you counts without pulling records.
- Cap what you list. If a collection has thousands of records, show a handful and
  say how many there are.
- Attribute apps carefully. A domain-shaped NSID suggests an app but does not
  prove it. Confirm with lexicon tools or hedge.
- The person asking might not be the account owner. Everything here is public
  either way, but keep it to what they asked about rather than producing an
  inventory of someone's life.
- If a collection looks like it holds something sensitive, describe its shape
  rather than dumping its contents.
