import { ProjectSticker } from "@/components/ProjectSticker";
import { Mascot } from "@/components/Mascot";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HomeButton } from "@/components/HomeButton";
import { PotatoTrail } from "@/components/PotatoTrail";
import { KonamiConfetti } from "@/components/KonamiConfetti";
import { LiveTicker } from "@/components/LiveTicker";
import { projects } from "@/lib/projects";

const SOCIALS = [
  { label: "bluesky", url: "https://bsky.app/profile/atpota.to", color: "var(--sky)" },
  { label: "github", url: "https://github.com/atpota-to", color: "var(--bg-elev)" },
  { label: "tangled", url: "https://tangled.sh/@atpota.to", color: "var(--blush)" },
];

const PROJECT_LAYOUT: { rotation: number; size: "sm" | "md" | "lg"; col: string }[] = [
  { rotation: -3, size: "lg", col: "md:col-span-7 md:row-span-2" },
  { rotation: 2.5, size: "md", col: "md:col-span-5" },
  { rotation: -1.5, size: "md", col: "md:col-span-5" },
  { rotation: 3, size: "sm", col: "md:col-span-7" },
];

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden">
      <PotatoTrail />
      <KonamiConfetti />

      {/* ===== HERO ===== */}
      <section className="relative min-h-[100svh] px-6 md:px-12 pt-16 pb-24 flex items-center">
        <div className="max-w-[1200px] mx-auto w-full grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-4 items-center">
          {/* Mascot */}
          <div className="md:col-span-5 flex justify-center md:justify-start order-1 md:order-2">
            <Mascot size={380} tilt={-6} follow float />
          </div>

          {/* Wordmark + tagline */}
          <div className="md:col-span-7 order-2 md:order-1 relative">
            <h1
              className="wordmark text-[20vw] md:text-[10.5rem] leading-[0.85] text-[var(--brown)]"
              style={{
                textShadow:
                  "4px 4px 0 var(--sticker-edge), -4px -4px 0 var(--sticker-edge), 4px -4px 0 var(--sticker-edge), -4px 4px 0 var(--sticker-edge), 4px 0 0 var(--sticker-edge), -4px 0 0 var(--sticker-edge), 0 4px 0 var(--sticker-edge), 0 -4px 0 var(--sticker-edge), 0 14px 24px rgba(40,30,10,0.25)",
              }}
            >
              <span style={{ display: "inline-block", transform: "rotate(-2deg)" }}>
                at
              </span>
              <span style={{ display: "inline-block" }}>potato</span>
            </h1>

            <p className="hand text-3xl md:text-4xl mt-6 max-w-xl text-[var(--ink-soft)]">
              a tiny studio making fun apps & helpful tools for the atproto-verse
            </p>

            <div className="mt-10 flex flex-wrap gap-3">
              {SOCIALS.map((s, i) => (
                <a
                  key={s.label}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sticker-card px-5 py-3 font-bold text-lg text-[var(--ink)] inline-block"
                  style={{
                    background: s.color,
                    transform: `rotate(${i % 2 === 0 ? -2 : 2}deg)`,
                  }}
                >
                  {s.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== PROJECTS ===== */}
      <section
        className="relative px-6 md:px-12 py-24 md:py-32"
        style={{ background: "var(--bg-elev)" }}
      >
        <div className="max-w-[1200px] mx-auto">
          <div className="flex items-end justify-between flex-wrap gap-6 mb-12 md:mb-16">
            <div>
              <p className="hand text-3xl text-[var(--sprout)] mb-1">we make stuff!</p>
              <h2
                className="wordmark text-6xl md:text-8xl text-[var(--brown)]"
                style={{
                  textShadow:
                    "3px 3px 0 var(--sticker-edge), -3px -3px 0 var(--sticker-edge), 3px -3px 0 var(--sticker-edge), -3px 3px 0 var(--sticker-edge), 3px 0 0 var(--sticker-edge), -3px 0 0 var(--sticker-edge), 0 3px 0 var(--sticker-edge), 0 -3px 0 var(--sticker-edge)",
                }}
              >
                what we&apos;re building
              </h2>
            </div>
            <div className="relative">
              <Mascot size={140} tilt={8} float thick={false} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8">
            {projects.map((project, i) => {
              const layout = PROJECT_LAYOUT[i] ?? PROJECT_LAYOUT[PROJECT_LAYOUT.length - 1];
              return (
                <div key={project.name} className={layout.col}>
                  <ProjectSticker
                    project={project}
                    rotation={layout.rotation}
                    size={layout.size}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ===== LIVE TICKER ===== */}
      <section className="relative py-20 md:py-28 overflow-hidden">
        <div className="max-w-[1200px] mx-auto px-6 md:px-12 mb-8">
          <p className="hand text-3xl text-[var(--blush)] mb-1">live wire 🥔</p>
          <h2
            className="wordmark text-5xl md:text-7xl text-[var(--brown)]"
            style={{
              textShadow:
                "3px 3px 0 var(--sticker-edge), -3px -3px 0 var(--sticker-edge), 3px -3px 0 var(--sticker-edge), -3px 3px 0 var(--sticker-edge), 3px 0 0 var(--sticker-edge), -3px 0 0 var(--sticker-edge), 0 3px 0 var(--sticker-edge), 0 -3px 0 var(--sticker-edge)",
            }}
          >
            fresh from the timeline
          </h2>
          <p className="text-[var(--ink-soft)] mt-3 max-w-xl">
            recent posts mentioning atpotato projects across Bluesky.
          </p>
        </div>
        <LiveTicker />
      </section>

      {/* ===== FOOTER ===== */}
      <section
        className="relative px-6 md:px-12 py-24 md:py-32"
        style={{ background: "var(--bg-elev)" }}
      >
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-12 gap-10 items-center">
          <div className="md:col-span-7 order-2 md:order-1">
            <p className="hand text-3xl text-[var(--sprout)] mb-2">say hi 👋</p>
            <a
              href="mailto:contact@atpota.to"
              className="wordmark text-4xl sm:text-5xl md:text-7xl text-[var(--brown)] block break-words"
              style={{
                textShadow:
                  "3px 3px 0 var(--sticker-edge), -3px -3px 0 var(--sticker-edge), 3px -3px 0 var(--sticker-edge), -3px 3px 0 var(--sticker-edge), 3px 0 0 var(--sticker-edge), -3px 0 0 var(--sticker-edge), 0 3px 0 var(--sticker-edge), 0 -3px 0 var(--sticker-edge)",
              }}
            >
              contact@atpota.to
            </a>

            <div className="mt-10 flex flex-wrap gap-4">
              <a
                href="/guides/bluesky-for-brands"
                className="sticker-card px-6 py-4 font-bold text-lg inline-block text-[var(--ink)]"
                style={{ background: "var(--sky)", transform: "rotate(-1.5deg)" }}
              >
                📘 read our brand guide
              </a>
              <span
                className="sticker-card px-6 py-4 hand text-2xl inline-block text-[var(--ink)]"
                style={{ background: "var(--bg)", transform: "rotate(1.5deg)" }}
              >
                more guides sprouting soon…
              </span>
            </div>

            <p className="hand text-xl mt-12 text-[var(--ink-soft)]">
              built with love and starch · © {new Date().getFullYear()} atpotato
            </p>
          </div>

          <div className="md:col-span-5 flex justify-center order-1 md:order-2">
            <div
              style={{
                transform: "rotate(4deg)",
              }}
            >
              <img
                src="/atpotato-kawaii.png"
                alt="atpotato signing off"
                className="sticker-img-thick w-[260px] md:w-[320px] h-auto"
                draggable={false}
              />
            </div>
          </div>
        </div>
      </section>

      <ThemeToggle />
      <HomeButton />
    </main>
  );
}
