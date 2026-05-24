"use client";

import { useEffect, useRef } from "react";

export function PotatoTrail() {
  const lastSpawn = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(hover: none)").matches) return;

    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      if (now - lastSpawn.current < 90) return;
      lastSpawn.current = now;

      const el = document.createElement("img");
      el.src = "/atpotato-normal.png";
      el.alt = "";
      el.setAttribute("aria-hidden", "true");
      el.style.position = "fixed";
      el.style.left = `${e.clientX - 12}px`;
      el.style.top = `${e.clientY - 12}px`;
      el.style.width = "24px";
      el.style.height = "24px";
      el.style.pointerEvents = "none";
      el.style.zIndex = "9998";
      el.style.opacity = "0.85";
      el.style.transition = "opacity 600ms ease, transform 600ms ease";
      el.style.transform = `rotate(${Math.random() * 360}deg)`;
      document.body.appendChild(el);

      requestAnimationFrame(() => {
        el.style.opacity = "0";
        el.style.transform += ` translateY(${(Math.random() - 0.5) * 18}px) scale(0.6)`;
      });
      window.setTimeout(() => el.remove(), 650);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return null;
}
