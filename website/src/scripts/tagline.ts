/**
 * The footer's little line ("grown in the atmosphere" in the markup, so it reads right
 * without JavaScript) becomes one of TAGLINES, picked fresh on every page load.
 */

export const TAGLINES: readonly string[] = [
  'grown in the atmosphere',
  '100% organic, 0% algorithm',
  'no potatoes were harmed',
  'best before: never',
  'locally sourced from your pds',
  'fresh from the firehose',
  'now with 20% more @',
  'peeled by hand',
  'mash responsibly',
  'rooted in open protocols',
  'part of a balanced feed',
  'contains: potato',
];

export function pickTagline(random: () => number = Math.random): string {
  return TAGLINES[Math.floor(random() * TAGLINES.length)] ?? TAGLINES[0]!;
}

export function initTagline(root: ParentNode = document, random: () => number = Math.random): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-tagline]')) el.textContent = pickTagline(random);
}
