"use client";

import { useEffect } from "react";

const SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

function burst() {
  const count = 36;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("img");
    el.src = "/atpotato-kawaii.png";
    el.alt = "";
    el.className = "confetti-potato";
    el.style.left = `${Math.random() * 100}vw`;
    el.style.setProperty("--dx", `${(Math.random() - 0.5) * 240}px`);
    el.style.setProperty("--dur", `${2.2 + Math.random() * 1.8}s`);
    el.style.width = `${24 + Math.random() * 32}px`;
    el.style.height = el.style.width;
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 4500);
  }
}

export function KonamiConfetti() {
  useEffect(() => {
    let buf: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      buf.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      if (buf.length > SEQUENCE.length) buf = buf.slice(-SEQUENCE.length);
      if (buf.length === SEQUENCE.length && buf.every((k, i) => k === SEQUENCE[i])) {
        burst();
        buf = [];
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
