"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = (localStorage.getItem("theme") as "light" | "dark" | null) ?? "light";
    setTheme(stored);
    document.documentElement.setAttribute("data-theme", stored);
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      className="fixed bottom-6 left-6 z-50 w-14 h-14 rounded-full text-2xl flex items-center justify-center sticker-card"
      style={{ background: "var(--bg-elev)" }}
    >
      {theme === "light" ? "🌚" : "🌞"}
    </button>
  );
}
