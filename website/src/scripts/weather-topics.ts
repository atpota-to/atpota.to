/**
 * The weather report's pages (/weather/<topic>): one part of the report on its own, at an
 * address of its own, with its own title and Open Graph card, so a link to the pds hosts
 * unfurls as the pds hosts rather than the whole sky. They're all weather/index.html: the
 * build (build/weather-topics.ts) writes a copy for each with these tags and
 * <html data-weather-topic="<slug>">, and weather.css shows only the tiles whose
 * data-topics names it. /weather itself is the whole report, and has no topic.
 *
 * No DOM here: the build reads it too.
 */

import type { LensPart } from './weather-dock';

export type TopicSlug = 'diversity' | 'trends' | 'today' | 'hosts' | 'migration';

export interface Topic {
  slug: TopicSlug;
  /** In the pages' nav, and on the dock's strip. */
  label: string;
  /** The header's title, and its lede. */
  title: string;
  lede: string;
  /** <title> and og:title. */
  pageTitle: string;
  description: string;
  /** Its card: /og/weather.png?card=<card> (server/og-weather-cards.ts). */
  card: 'mix' | 'trend' | 'today' | 'hosts' | 'migration';
  alt: string;
  /** The lens's controls that reach its tiles (weather-dock.ts dims the rest). */
  lens: readonly LensPart[];
  /** What Poe's nudge says (body[data-poe-nudge]); in Poe's voice, so lowercase and a kaomoji only at the end. */
  nudge: string;
}

export const SITE = 'https://atpota.to';

export const TOPICS: readonly Topic[] = [
  {
    slug: 'diversity',
    label: 'diversity',
    title: 'who else is in the sky',
    lede: 'the diversity index, bluesky against everyone else, and the busiest apps writing outside bluesky.',
    pageTitle: 'the diversity index · the atmosphere weather report · atpotato',
    description:
      "how much of the atmosphere isn't bluesky: the diversity index (the share of active accounts writing with other apps, and how many apps they're spread across), which apps are busiest, and which are new, read live from the firehose.",
    card: 'mix',
    alt: 'the diversity index on its scale as it was when this was shared, and the busiest apps outside bluesky over the last 24 hours.',
    lens: ['window', 'measure', 'unit'],
    nudge: 'psst. ask me how the diversity index works (◕‿◕)',
  },
  {
    slug: 'trends',
    label: 'trends',
    title: 'how the sky has moved',
    lede: 'new records and active accounts over the last hour, day, week or month, and the readouts for the same stretch.',
    pageTitle: 'trends · the atmosphere weather report · atpotato',
    description:
      'how busy the atmosphere has been: new records and active accounts over the last hour, 24 hours, 7 days or 30 days, with the diversity index and the apps heard along the way.',
    card: 'trend',
    alt: 'the last 24 hours of new records a second across the whole network as a chart, with the busiest and quietest hours marked.',
    lens: ['window', 'measure', 'unit'],
    nudge: 'psst. ask me what a lexicon is (◕‿◕)',
  },
  {
    slug: 'today',
    label: 'today',
    title: 'today and the outlook',
    lede: "today's high and low against usual, apps new to the atmosphere, the next 12 hours, and when in the week the sky is busiest.",
    pageTitle: 'today and the outlook · the atmosphere weather report · atpotato',
    description:
      "the atmosphere's almanac: today's high and low, whether it's busier or quieter than usual, apps heard for the first time, a forecast for the next 12 hours, and the week as a heat map.",
    card: 'today',
    alt: 'the last hour against usual on a barometer, and today in numbers: its range, how much was written, and how much of it came from other apps.',
    lens: ['unit'],
    nudge: 'psst. ask me how the forecast works (◕‿◕)',
  },
  {
    slug: 'hosts',
    label: 'pds hosts',
    title: 'where the atmosphere lives',
    lede: "the servers that hold everyone's accounts: how many accounts live off bluesky's own, across how many independent hosts, and which are growing.",
    pageTitle: 'pds hosts and independence · the atmosphere weather report · atpotato',
    description:
      "where the atmosphere's accounts live: how many are on independent pds hosts rather than bluesky's own, how spread out they are (hosting diversity), the biggest, newest and fastest growing hosts, and a census of every host the relay knows.",
    card: 'hosts',
    alt: "the share of accounts living on independent pds hosts as it was when this was shared, the hosting diversity on its scale, and the biggest independent hosts by accounts.",
    lens: ['window'],
    nudge: 'psst. ask me what a pds is (◕‿◕)',
  },
  {
    slug: 'migration',
    label: 'migration',
    title: 'moving house',
    lede: "who's packing up their account and moving to another host, out of bluesky, back in or host to host, and where new accounts sign up.",
    pageTitle: 'pds migration · the atmosphere weather report · atpotato',
    description:
      "accounts moving house in the atmosphere: how many moved out of bluesky's pds hosts, back in or between independent ones, where they went, and where new accounts sign up, read from the plc directory.",
    card: 'migration',
    alt: 'how many accounts moved out of bluesky to independent pds hosts over the last week, day by day, how many moved back, and where they went.',
    lens: ['window'],
    nudge: 'psst. ask me how moving your account works (◕‿◕)',
  },
];

export function topicBySlug(slug: string | null | undefined): Topic | null {
  return TOPICS.find((t) => t.slug === slug) ?? null;
}

/** The page's own address: /weather, or /weather/<slug>. */
export const topicPath = (t: Topic | null) => (t ? `/weather/${t.slug}` : '/weather');

/** The topic of the page this document is ([data-weather-topic] on <html>), or null on the whole report. */
export function topicOf(doc: Document | null | undefined): Topic | null {
  return topicBySlug(doc?.documentElement?.dataset.weatherTopic);
}
