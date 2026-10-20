import { defineTool } from "eve/tools";
import { z } from "zod";
import { readPresence, type Issue } from "../lib/presence";

/** The issue a link or record key names: atpota.to/blog, poe.leaflet.pub or at:// forms. */
function find(issues: Issue[], wanted: string): Issue | null {
  const value = wanted.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!value || value === "latest") return issues[0] ?? null;
  return issues.find((issue) => value === issue.uri || value === issue.rkey || value === issue.link ||
    value === issue.leafletLink || value.endsWith(`/${issue.rkey}`)) ?? null;
}

// Read-only and public: the same records atpota.to/blog renders. Open to every
// channel, website visitors included, so any Poe can talk about its own work.
export default defineTool({
  description:
    "Read your own weekly dispatch, poe's atmosphere dispatch. Returns your newest issues with their " +
    "titles, dates, descriptions and links, plus the full text of one issue (the latest unless you " +
    "name another). Use it before you say what is in an issue, and to get a link you can share: " +
    "`link` is the issue on atpota.to/blog, `leafletLink` the same issue on poe.leaflet.pub.",
  inputSchema: z.object({
    issue: z.string().max(600).optional()
      .describe('"latest" (the default), or an issue link or record key someone gave you'),
  }),
  async execute(input) {
    const { issues } = await readPresence();
    if (!issues.length) {
      return { found: false, reason: "no issues could be read right now; the dispatch may be unreachable" };
    }
    const chosen = find(issues, input.issue ?? "latest");
    return {
      found: chosen !== null,
      ...(chosen ? {} : { reason: "that issue is not one of the newest issues; here are the ones that are" }),
      issues: issues.map(({ title, description, publishedAt, link, leafletLink }) =>
        ({ title, description, publishedAt, link, leafletLink })),
      ...(chosen ? { issue: { title: chosen.title, publishedAt: chosen.publishedAt, link: chosen.link,
        leafletLink: chosen.leafletLink, text: chosen.text ?? chosen.description ?? "" } } : {}),
    };
  },
});
