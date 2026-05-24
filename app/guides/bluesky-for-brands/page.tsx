import fs from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import type { Metadata } from "next";
import { HomeButton } from "@/components/HomeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GuideEnhancements } from "./GuideEnhancements";
import "./guide-styles.css";

export const metadata: Metadata = {
  title: "How to use Bluesky to grow your brand - atpotato",
  description:
    "A comprehensive guide for companies, communities, and creators looking to establish and grow their presence on Bluesky.",
  openGraph: {
    type: "article",
    url: "https://atpota.to/guides/bluesky-for-brands",
    title: "How to use Bluesky to grow your brand - atpotato",
    description:
      "A comprehensive guide for companies, communities, and creators looking to establish and grow their presence on Bluesky.",
    images: ["/bsky-guide-og.png"],
  },
};

async function loadMarkdown(): Promise<string> {
  const file = path.join(
    process.cwd(),
    "public",
    "guides",
    "how-to-use-bluesky-to-grow-your-brand.md"
  );
  const md = await fs.readFile(file, "utf8");
  marked.setOptions({ gfm: true });
  return marked.parse(md, { async: false }) as string;
}

export default async function GuidePage() {
  const html = await loadMarkdown();

  return (
    <>
      <div className="guide-container">
        <main className="guide-content">
          <header className="guide-header">
            <h1>How to use Bluesky to grow your brand</h1>
            <h2>A comprehensive guide for companies, communities, and creators</h2>
            <div className="guide-meta">
              <span className="reading-time">📚 calculating...</span>
              <span className="meta-separator">·</span>
              <span className="guide-author">
                written by{" "}
                <a href="https://bsky.app/profile/dame.is" target="_blank" rel="noopener noreferrer">
                  @dame.is
                </a>
              </span>
            </div>
            <p className="support-thanks">
              <em>
                Thanks to{" "}
                <a
                  href="https://bsky.app/profile/protocollabs.bsky.social"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Protocol Labs
                </a>{" "}
                for their support in helping make this guide possible.
              </em>
            </p>
          </header>

          <div id="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
      </div>

      <div className="button-backdrop" />
      <GuideEnhancements />
      <HomeButton />
      <ThemeToggle />
    </>
  );
}
