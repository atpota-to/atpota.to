export type ProjectColor = "sprout" | "moss" | "tan" | "cream" | "brown";

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
    tagline:
      "Tour the Atmosphere. Switch between clients, share universal links, and browse any account's PDS data.",
    color: "sprout",
  },
  {
    name: "Anisota",
    url: "https://anisota.net",
    tagline:
      "A more peaceful kind of social media interface — be offline more and online better. For Bluesky and the Atmosphere.",
    color: "cream",
  },
  {
    name: "Flushes",
    url: "https://flushes.app",
    tagline:
      "The Decentralized Toilet Network of Planet Earth & Simulation 12B. The world's first decentralized social toilet.",
    color: "tan",
  },
  {
    name: "cred.blue",
    url: "https://cred.blue",
    tagline:
      "Generate a Bluesky social score. Understand your AT Protocol data footprint. Vibe-check strangers on the network.",
    color: "moss",
  },
  {
    name: "more sprouting…",
    url: "",
    tagline: "we're always cooking something new",
    color: "brown",
  },
];
