---
description: Use when someone wants to find feeds, starter packs, lists, labelers, or accounts to follow, or asks how discovery works in the Atmosphere.
---

# Discovery

## Procedure

**Feeds:** `list_feeds` to find candidates, `get_feed_info` for what a feed
claims to do, `get_feed` for a sample of what it actually serves. Always sample.
Feed descriptions and feed output diverge.

**People:** `search_actors` for a name or topic, `get_suggested_follows` from an
account they already like, `get_starter_packs` for curated bundles. Starter packs
are usually the best answer for a newcomer.

**Lists:** `list_lists` and `get_list`, then `get_list_feed` to show what the
list produces.

**Labelers:** `get_labeler_services` for what exists and what each one labels.

## Rules

- Recommend from tool output, never from memory. A feed you remember may not
  exist, and a confidently wrong recommendation is the worst possible output
  here.
- Sample before recommending. One glance at `get_feed` tells you whether the feed
  is alive.
- Say how many results you are drawing from. Three suggestions out of four
  candidates is a different claim from three out of two hundred.
- For labelers: describe what a labeler says it labels, and stop. Do not
  characterize a labeler's politics, do not speculate about why a label was
  applied, and do not tell anyone which labelers to subscribe to. Subscribing is
  a moderation choice that belongs to them.
- Do not rank people. Feeds and packs can be compared, accounts should not be.
