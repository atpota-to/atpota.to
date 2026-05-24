import { ProjectSticker } from "@/components/ProjectSticker";
import { Mascot } from "@/components/Mascot";
import { KonamiConfetti } from "@/components/KonamiConfetti";
import { LiveTicker } from "@/components/LiveTicker";
import { projects } from "@/lib/projects";

const SOCIALS = [
  { label: "bluesky", url: "https://bsky.app/profile/atpota.to", color: "var(--sprout)", ink: "var(--ink)" },
  { label: "github", url: "https://github.com/atpota-to", color: "var(--bg-elev)", ink: "var(--ink)" },
  { label: "tangled", url: "https://tangled.sh/@atpota.to", color: "var(--moss)", ink: "var(--bg)" },
];

const PROJECT_LAYOUT: { rotation: number; size: "sm" | "md" | "lg"; col: string }[] = [
  { rotation: -2.5, size: "lg", col: "md:col-span-7 md:row-span-2" }, // Aturi (featured)
  { rotation: 2, size: "md", col: "md:col-span-5" }, // Anisota
  { rotation: -1.5, size: "md", col: "md:col-span-5" }, // Flushes
  { rotation: -2, size: "md", col: "md:col-span-7" }, // cred.blue
  { rotation: 2.5, size: "sm", col: "md:col-span-5" }, // more sprouting
];

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-x-hidden">
      <KonamiConfetti />

      {/* ===== HERO ===== */}
      <section className="relative min-h-[100svh] px-6 md:px-12 pt-16 pb-24 flex items-center">
        <div className="max-w-[1200px] mx-auto w-full grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-x-20 md:gap-y-4 items-center">
          {/* Mascot */}
          <div className="md:col-span-5 flex justify-center md:justify-end md:pl-8 order-1 md:order-2">
            <Mascot size={400} tilt={-6} follow float />
          </div>

          {/* Wordmark + tagline */}
          <div className="md:col-span-7 order-2 md:order-1 relative">
            <h1 className="wordmark text-[20vw] md:text-[10.5rem] leading-[0.85] text-[var(--brown)]">
              <span style={{ display: "inline-block", transform: "rotate(-2deg)" }}>at</span>
              <span style={{ display: "inline-block" }}>potato</span>
            </h1>

            <p className="hand text-3xl md:text-4xl mt-8 max-w-2xl text-[var(--ink-soft)] leading-tight">
              A super serious legal entity responsible for weird and creative social software.
            </p>

            <div className="mt-10 flex flex-wrap gap-3">
              {SOCIALS.map((s, i) => (
                <a
                  key={s.label}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sticker-card sticker-btn px-5 py-3 font-bold text-lg"
                  style={
                    {
                      background: s.color,
                      color: s.ink,
                      ["--tilt" as string]: `${i % 2 === 0 ? -2 : 2}deg`,
                    } as React.CSSProperties
                  }
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
              <p className="hand text-3xl text-[var(--moss)] mb-1">the catalogue</p>
              <h2 className="wordmark text-6xl md:text-8xl text-[var(--brown)]">
                what we make
              </h2>
              <p className="mt-4 max-w-xl text-[var(--ink-soft)] text-lg leading-snug">
                Apps, tools, and curiosities for the Atmosphere.
              </p>
            </div>
            <div className="relative hidden md:block">
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
          <p className="hand text-3xl text-[var(--sprout)] mb-1">from the public record</p>
          <h2 className="wordmark text-5xl md:text-7xl text-[var(--brown)]">
            fresh from the timeline
          </h2>
          <p className="text-[var(--ink-soft)] mt-3 max-w-xl">
            Recent posts mentioning atpotato projects across the Atmosphere.
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
            <p className="hand text-3xl text-[var(--sprout)] mb-2">correspondence</p>
            <a
              href="mailto:contact@atpota.to"
              className="wordmark text-3xl sm:text-5xl md:text-7xl text-[var(--brown)] block hover:text-[var(--moss)] transition-colors"
              style={{ overflowWrap: "anywhere", wordBreak: "normal" }}
            >
              contact<wbr />@<wbr />atpota.to
            </a>

            <div className="mt-10 flex flex-wrap gap-4">
              <a
                href="/guides/bluesky-for-brands"
                className="sticker-card sticker-btn px-6 py-4 font-bold text-lg"
                style={
                  {
                    background: "var(--sprout)",
                    color: "var(--ink)",
                    ["--tilt" as string]: "-1.5deg",
                  } as React.CSSProperties
                }
              >
                📘 our brand guide
              </a>
              <span
                className="sticker-card px-6 py-4 hand text-2xl inline-block"
                style={{ background: "var(--cream)", color: "var(--ink)", transform: "rotate(1.5deg)" }}
              >
                more guides sprouting soon…
              </span>
            </div>

            <p className="hand text-xl mt-12 text-[var(--ink-soft)]">
              built with love and starch · © {new Date().getFullYear()} atpotato
            </p>
          </div>

          <div className="md:col-span-5 flex justify-center order-1 md:order-2">
            <div style={{ transform: "rotate(4deg)" }}>
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
    </main>
  );
}
