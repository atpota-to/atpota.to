export type ProjectColor = "blush" | "sky" | "sprout" | "tan";

export type Project = {
  name: string;
  url: string;
  tagline: string;
  color: ProjectColor;
};

export const projects: Project[] = [
  {
    name: "Aturi",
    url: "https://aturi.to",
    tagline: "a cozy place for your atproto identity",
    color: "blush",
  },
  {
    name: "Anisota",
    url: "https://anisota.net",
    tagline: "track and share what you're watching",
    color: "sky",
  },
  {
    name: "Flushes",
    url: "https://flushes.app",
    tagline: "the silliest little social network",
    color: "sprout",
  },
  {
    name: "more sprouting…",
    url: "",
    tagline: "we're always cooking something new",
    color: "tan",
  },
];
