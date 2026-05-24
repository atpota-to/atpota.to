"use client";

import Link from "next/link";

export function HomeButton() {
  return (
    <Link
      href="/"
      aria-label="Home"
      className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center sticker-card"
      style={{ background: "var(--bg-elev)" }}
    >
      <img
        src="/atpotato-normal.png"
        alt="atpotato"
        className="w-10 h-10 object-contain"
        draggable={false}
      />
    </Link>
  );
}
