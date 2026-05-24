"use client";

import { motion } from "framer-motion";
import type { Project, ProjectColor } from "@/lib/projects";

const accentBg: Record<ProjectColor, string> = {
  sprout: "var(--sprout)",
  moss: "var(--moss)",
  tan: "var(--tan)",
  cream: "var(--cream)",
  brown: "var(--brown)",
};

// Dark backgrounds (moss, brown) get cream ink; others get deep ink.
const accentInk: Record<ProjectColor, string> = {
  sprout: "var(--ink)",
  moss: "var(--bg)",
  tan: "var(--ink)",
  cream: "var(--ink)",
  brown: "var(--bg)",
};

type Props = {
  project: Project;
  rotation?: number;
  size?: "sm" | "md" | "lg";
};

export function ProjectSticker({ project, rotation = 0, size = "md" }: Props) {
  const sizeClass =
    size === "lg"
      ? "p-8 min-h-[260px]"
      : size === "sm"
      ? "p-6 min-h-[170px]"
      : "p-7 min-h-[210px]";

  const titleSize =
    size === "lg" ? "text-5xl md:text-6xl" : size === "sm" ? "text-3xl" : "text-4xl";

  const ink = accentInk[project.color];

  const Inner = (
    <div
      className={`sticker-card ${sizeClass} flex flex-col justify-between gap-4`}
      style={{ background: accentBg[project.color], color: ink }}
    >
      <div>
        <h3 className={`wordmark ${titleSize}`} style={{ color: ink }}>
          {project.name}
        </h3>
        <p className="hand text-2xl mt-3 leading-snug opacity-90" style={{ color: ink }}>
          {project.tagline}
        </p>
      </div>
      {project.url && (
        <div className="self-end text-xl font-bold tracking-tight" style={{ color: ink }}>
          visit →
        </div>
      )}
    </div>
  );

  const motionProps = {
    initial: { rotate: rotation },
    whileHover: { rotate: rotation * 0.15, scale: 1.04, y: -6 },
    transition: { type: "spring" as const, stiffness: 220, damping: 18 },
    style: { rotate: rotation },
  };

  if (!project.url) {
    return <motion.div {...motionProps}>{Inner}</motion.div>;
  }

  return (
    <motion.a
      href={project.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block"
      {...motionProps}
    >
      {Inner}
    </motion.a>
  );
}
