"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

type StickerProps = {
  children: ReactNode;
  rotation?: number;
  className?: string;
  hover?: boolean;
};

export function Sticker({ children, rotation = 0, className = "", hover = true }: StickerProps) {
  return (
    <motion.div
      className={`sticker-card ${className}`}
      initial={{ rotate: rotation }}
      whileHover={hover ? { rotate: rotation * 0.2, scale: 1.04, y: -4 } : undefined}
      transition={{ type: "spring", stiffness: 240, damping: 18 }}
      style={{ rotate: rotation }}
    >
      {children}
    </motion.div>
  );
}
