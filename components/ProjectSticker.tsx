"use client";

import { motion } from "framer-motion";
import type { Project, ProjectColor } from "@/lib/projects";

const accentVar: Record<ProjectColor, string> = {
  blush: "var(--blush)",
  sky: "var(--sky)",
  sprout: "var(--sprout)",
  tan: "var(--tan)",
};

type Props = {
  project: Project;
  rotation?: number;
  size?: "sm" | "md" | "lg";
};

export function ProjectSticker({ project, rotation = 0, size = "md" }: Props) {
  const sizeClass =
    size === "lg"
      ? "p-8 min-h-[220px]"
      : size === "sm"
      ? "p-5 min-h-[150px]"
      : "p-6 min-h-[180px]";

  const titleSize =
    size === "lg" ? "text-5xl" : size === "sm" ? "text-3xl" : "text-4xl";

  const Inner = (
    <div
      className={`sticker-card ${sizeClass} flex flex-col justify-between gap-3`}
      style={{ background: accentVar[project.color] }}
    >
      <div>
        <h3
          className={`wordmark ${titleSize} text-[var(--ink)]`}
          style={{
            color: "var(--ink)",
            textShadow:
              "2px 2px 0 var(--sticker-edge), -2px -2px 0 var(--sticker-edge), 2px -2px 0 var(--sticker-edge), -2px 2px 0 var(--sticker-edge), 2px 0 0 var(--sticker-edge), -2px 0 0 var(--sticker-edge), 0 2px 0 var(--sticker-edge), 0 -2px 0 var(--sticker-edge)",
          }}
        >
          {project.name}
        </h3>
        <p className="hand text-2xl mt-2 text-[var(--ink)] opacity-80">
          {project.tagline}
        </p>
      </div>
      {project.url && (
        <div className="self-end text-xl font-bold text-[var(--ink)]">
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
