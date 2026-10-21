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

Read `archive` too, when it's there. The station has listened live since october 20;
a week from before that was filled in from Jetstream's archive, which keeps about a
fifth of the edits other apps lean on. Say so once, in passing ("this week comes from
jetstream's archive, which hears less of the other apps"). Records a second, the
hours and the days stand as they are. The diversity index and the apps outside
Bluesky read low for that part: give them, but never set them against a live week's.
When `archive.note` says an app's change can be the archive's doing, leave the apps'
changes out.

## What goes in

The section has a fixed shape, so readers find the numbers in the same place every
week. It reads like the rest of the issue: a paragraph, then a list like shipped
and growing and shrinking, then the outlook.

1. **The headline**, one or two sentences. Open with the week's condition in bold
   ("**a light week.**"), then the week's new records a second against the week
   before (`weekBefore.changePercent`), and the diversity index with its level (and
   `weekBefore.mix`, how mixed a sky it was against the week before, when it's
   there). Round the way a person would: "about 450 new records a second", "an
   index of 1.7".
2. **The week at a glance**, a list of two to four items. Each opens with a bold
   label and a colon, the way the issue's other lists open with the app's name.
   Pick the ones that say something this week:
   - **busiest hour** and **quietest hour** (`busiestHour`, `quietestHour`), each
     with its new records a second and its condition.
   - **busiest day**, from `days`, or the month's busiest and quietest day (`month`)
     when they fall in this week.
   - **outside bluesky**: the busiest apps (`apps`) and how each did against the
     week before (`change`), especially one that is new or way up. `sharePercent`
     is its share of everything written outside Bluesky.
   - **accounts**: active accounts (`accounts`), only when they say something the
     records don't.
3. **The outlook**, last, in its own paragraph, opening with "**the outlook.**" in
   bold. See below.
4. **The weather page's link**, exactly as `page` returned it, on a line of its own,
   so it turns into a link card in Leaflet.

The first issue with a weather section explains it in a sentence: the station on
atpota.to counts every new record in the firehose, Bluesky's and every other app's,
and the diversity index is how much of the network isn't Bluesky, by the share of
active accounts writing with other apps and how many apps they're spread across (so
one account writing a thousand records counts once). If your newest issue already
has a weather section, skip the explanation.

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
under a plain lowercase heading, "atmospheric conditions". It goes after growing
and shrinking and before your sign-off line, so the issue's last section looks
ahead. When the issue's opening says what the dispatch covers, name the weather
too ("...then write up what i found, ending with the weather from my weather
station").
