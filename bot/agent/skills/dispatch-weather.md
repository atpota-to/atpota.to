---
description: Use when writing an issue of poe's atmosphere dispatch, its weather section or its outlook, or when someone asks for a weekly weather report or a forecast for the Atmosphere. Covers read_weather's week report, what the weather section holds, and how to forecast without promising anything.
---

# The weather in the dispatch

Every issue of the dispatch ends with the weather: how the Atmosphere's sky looked
this week, from your own weather station on atpota.to, and an outlook for the week
ahead. You write it yourself, from the station's numbers, in your own voice.

## Get the numbers

Call read_weather with `report: "week"` once, while you write the issue. That one
call has everything this section needs. Don't build a week out of `now` readings;
each of those is a single minute. Leave `timeZone` as UTC unless the issue is about
one place's hours, and say "utc" when you give an hour.

If read_weather comes back unavailable, keep the section to one line saying the
station wasn't answering when you wrote the issue. No numbers from memory.

Read `heardPercent` and `note` before you write a number. The station only reports
what it heard. Under 90%, say in passing how much of the week it heard ("the station
caught about four days of it"). Anything the report leaves out could not be worked
out: a part named in `unavailable`, a `weekBefore` with `available: false`, an app
with no `change`. Leave it out rather than guess at it.

## What goes in

Three short paragraphs at most. Pick what was interesting this week; you don't
need all of it.

- **The headline.** The week's new records a second and its condition, against the
  week before (`weekBefore.changePercent`), and the diversity index with its level.
  Round the way a person would: "about 450 new records a second", "0.42%".
- **What moved the sky.** The busiest apps outside Bluesky (`apps`) and how each did
  against the week before (`change`), especially one that is new or way up.
  `sharePercent` is its share of everything written outside Bluesky. Active accounts
  (`accounts`) when they say something the records don't.
- **The extremes.** The busiest and quietest hour (`busiestHour`, `quietestHour`),
  the busiest day in `days`, and the month's busiest and quietest day (`month`).
- **The outlook.** Last, in its own paragraph. See below.

The first issue with a weather section explains it in a sentence: the station on
atpota.to counts every new record in the firehose, Bluesky's and every other app's,
and the diversity index is the share written by apps other than Bluesky. If your
newest issue already has a weather section, skip the explanation.

Use the station's own weather words, because readers see the same ones on the
weather page: calm, light, breezy, gusty and stormy by new records a second, and the
diversity index's levels, which work like the UV index. Don't invent thresholds of
your own. One or two weather jokes (an app blew in, a front of likes rolled
through), not one in every sentence.

Apps are named by their namespace as a domain (`tangled.sh`), the way the station
counts them. That is the station's name for the app, not proof of who runs it; look
it up before you say who built it. If an app here also shows up in growing and
shrinking or in new lexicons, talk about it once and point to the other section.

## The outlook

A forecast built only from `outlook`: the usual week (`weekdays`, `busiestHours`,
`quietestHours`, `hoursByCondition`), how this week compared with usual (`perSecond`
against `outlook.usualPerSecond`), and `appsToWatch`. Say it like a forecast:
"expect the gustiest skies on thursday afternoons around 15:00 utc and a calm sunday
morning", "keep an eye on tangled.sh, up 200% on the week before".

- It is a pattern, not a promise. Say "usually" or "if the usual week holds" once.
- Never forecast an event, a launch, an outage or a spike the numbers don't show,
  and give no number for a day beyond what `weekdays` says.
- If `outlook.ready` is false, say cheerfully that the station is still learning
  what a usual week looks like, so there's no forecast yet. Never make one up.

## Format

The same as the rest of the issue: lowercase, plain sentences, short paragraphs,
under a plain lowercase heading, "atmospheric conditions". It goes last, after
growing and shrinking, so the issue ends looking ahead. Close the section with the
weather page's link exactly as `page` returned it.
