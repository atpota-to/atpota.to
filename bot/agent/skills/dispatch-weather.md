---
description: Use when writing an issue of poe's atmosphere dispatch, its weather section or its outlook, or when someone asks for a weekly weather report or a forecast for the Atmosphere. Covers read_weather's week report, what the weather section holds, and how to forecast without promising anything.
---

# The weather in the dispatch

Every issue of the dispatch ends with a short note on the weather: how the
Atmosphere's sky looked this week, from your own weather station on atpota.to. You
write it yourself, from the station's numbers, in your own voice.

## Sound like you

This is you on the roof with the weather vane, not a station printout. React to the
sky the way you would in a weather post: a storm is exciting, a quiet week is cozy, a
new app blowing in is somebody to say hi to. One line of your own and at most one
face. Your reaction never changes the numbers.

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

Keep it short. Most weeks the weather is two or three sentences, and that's fine:
readers came for the rest of the issue. Go into detail only when something actually
stood out, and then give the one number that makes it interesting. No lists of
routine numbers.

1. **The headline**, always: the week's condition and new records a second against
   the week before (`weekBefore.changePercent`), and the diversity index with its
   level (and `weekBefore.mix`, how mixed a sky it was against the week before, when
   it's there). Round the way a person would: "about 450 new records a second", "an
   index of 1.7". A bare index means nothing to most readers, so give its range
   whenever you give it: it works like the uv index, low under 3 and extreme at 11
   or more.
2. **What stood out**, only if something did, in a sentence or two: a storm and what
   drove it, an app that blew in or is way up (`apps`, `change`), a sky much more or
   less mixed than usual, a week well above or below usual. The busiest and
   quietest hours are news only when they break the usual daily rhythm. A burst
   (`bursts`: one app writing a flood of records in a minute, a bulk import) is left
   out of the weather, so it's never the busiest hour or a forecast, but a big one can
   be the thing that stood out: name the app, how many records, and how fast.
3. **The outlook**, only when it says something worth knowing. See below.
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

Skip it unless it tells readers something: an app on the rise worth watching, or a
usual week that this one broke. When you give one, it's a sentence, built only from
`outlook`: the usual week (`weekdays`, `busiestHours`, `quietestHours`,
`hoursByCondition`), how this week compared with usual (`perSecond` against
`outlook.usualPerSecond`), and `appsToWatch`. Say it like a forecast:
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
and shrinking and before your sign-off line. When the issue's opening says what the
dispatch covers, name the weather too ("...then write up what i found, ending with
the weather from my weather station").
