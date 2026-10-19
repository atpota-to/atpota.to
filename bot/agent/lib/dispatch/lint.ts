/**
 * Deterministic checks on a dispatch draft, run before the editor and again on
 * the final text. The droplet runs the identifier check a second time before
 * anything is published (mentions/DISPATCH.md).
 *
 * The identifier rule is the eval suite's grounding rule
 * (evals/shared/grounding.ts) pointed at the week's data instead of tool
 * results: every link, NSID and DID in the draft must appear in what was
 * collected. Deliberately strict about where an identifier may come from and
 * permissive about what counts as one; a false positive costs an editor pass,
 * a miss costs a published invention.
 */

export type LintReport = {
  ok: boolean;
  words: number;
  ungrounded: string[];
  bareMentions: string[];
  bannedPhrases: string[];
  emDashes: number;
  rawHtml: boolean;
  unroundedEstimates: string[];
  vagueLinks: number;
};

/**
 * Links whose text says nothing, like "[post](...)". The fourth demo run wrote
 * "([post](...))" after nearly every claim although the guide's examples
 * linked the words themselves.
 */
export function vagueLinks(markdown: string): number {
  return [...markdown.matchAll(/\[(post|posts|link|here|this|source)\]\(/gi)].length;
}

/**
 * "about 4,685" claims a precision the HyperLogLog estimate does not have.
 * At 1,000 and up an estimate should be a round hundred, from 100 to 999 a
 * round ten; below 100 any number reads as approximate already.
 */
export function unroundedEstimates(markdown: string): string[] {
  return [...markdown.matchAll(/\babout ([\d,]+)\b/gi)]
    .filter((m) => {
      const n = Number(m[1].replaceAll(",", ""));
      return (n >= 1000 && n % 100 !== 0) || (n >= 100 && n < 1000 && n % 10 !== 0);
    })
    .map((m) => m[0]);
}

export const BANNED_PHRASES = [
  "dive in", "unlock", "seamless", "in the world of", "it's not just", "game-changer", "game changer",
  "revolutionary", "great question", "delve", "leverage", "utilize", "foster", "bolster", "underscore",
  "unveil", "streamline", "robust", "comprehensive", "pivotal", "landscape", "tapestry", "ever-evolving",
  "testament to", "significantly", "extremely", "truly", "furthermore", "moreover", "it's worth noting",
  "it's important to note", "in today's", "stay tuned", "that's a wrap",
];

const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"'`]+/g;
const TRAILING = /[.,;:!?*_]+$/;
// NSIDs are written in backticks; DIDs anywhere.
const BACKTICKED = /`([^`\s]+)`/g;
const NSID = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+){2,}$/;
const DID = /\bdid:(?:plc|web):[a-zA-Z0-9._:%-]+/g;
// A bare @handle: not inside link text, not part of an email address.
const BARE_MENTION = /(?<![\w\[])@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+/g;

function normalize(url: string): string {
  return url.replace(TRAILING, "").replace(/\/$/, "");
}

/**
 * The set of identifiers a draft may use, from the dataset as one string. A
 * URL counts if it appears in the data or is one of `extra` (links the code
 * itself generates, such as profile URLs).
 */
export function groundingCheck(markdown: string, haystack: string, extra: Iterable<string> = []): string[] {
  const allowed = new Set([...extra].map(normalize));
  const known = (id: string) => allowed.has(normalize(id)) || haystack.includes(normalize(id));
  const claimed = new Set<string>();
  for (const match of markdown.matchAll(URL_PATTERN)) claimed.add(match[0].replace(TRAILING, ""));
  for (const match of markdown.matchAll(BACKTICKED)) if (NSID.test(match[1])) claimed.add(match[1]);
  for (const match of markdown.matchAll(DID)) claimed.add(match[0].replace(TRAILING, ""));
  return [...claimed].filter((id) => !known(id));
}

/**
 * The words a reader reads: link text without its URL, no code spans, no bare
 * URLs. Phrase checks run on this, because the second demo run's editor cut a
 * real lexicon, `town.delve.feed.post`, when "delve" matched the NSID.
 */
export function prose(markdown: string): string {
  return markdown
    .replace(/`[^`]*`/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(URL_PATTERN, " ");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function lintDraft(markdown: string, haystack: string, extra: Iterable<string> = []): LintReport {
  const words = prose(markdown).toLowerCase();
  const withoutLinks = markdown.replace(/\[[^\]]*\]\([^)]*\)/g, "");
  const report = {
    words: markdown.split(/\s+/).filter(Boolean).length,
    ungrounded: groundingCheck(markdown, haystack, extra),
    bareMentions: [...new Set([...withoutLinks.matchAll(BARE_MENTION)].map((m) => m[0]))],
    bannedPhrases: BANNED_PHRASES.filter((phrase) => new RegExp(`(?<![\\w-])${escape(phrase)}(?![\\w-])`).test(words)),
    emDashes: [...markdown].filter((ch) => ch === "—").length,
    rawHtml: /<\/?[a-zA-Z][^>]*>/.test(markdown),
    unroundedEstimates: unroundedEstimates(markdown),
    vagueLinks: vagueLinks(markdown),
  };
  return {
    ok: report.ungrounded.length === 0 && report.bareMentions.length === 0 && report.bannedPhrases.length === 0 &&
      report.emDashes === 0 && !report.rawHtml && report.unroundedEstimates.length === 0 && report.vagueLinks === 0,
    ...report,
  };
}
