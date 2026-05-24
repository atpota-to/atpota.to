"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const EXPRESSIONS = [
  "/atpotato-normal.png",
  "/atpotato-dead.png",
  "/atpotato-waow.png",
  "/atpotato-scawy.png",
  "/atpotato-kawaii.png",
] as const;

const HOVER_POOL = EXPRESSIONS.slice(1);

type MascotProps = {
  size?: number;
  className?: string;
  thick?: boolean;
  follow?: boolean;
  float?: boolean;
  tilt?: number;
};

export function Mascot({
  size = 320,
  className = "",
  thick = true,
  follow = false,
  float = true,
  tilt = 0,
}: MascotProps) {
  const [src, setSrc] = useState<string>("/atpotato-normal.png");
  const [shake, setShake] = useState(false);
  const clickStreakRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const randomExpression = useCallback(() => {
    return HOVER_POOL[Math.floor(Math.random() * HOVER_POOL.length)];
  }, []);

  const handleEnter = () => setSrc(randomExpression());
  const handleLeave = () => setSrc("/atpotato-normal.png");

  const handleTouch = (e: React.TouchEvent) => {
    e.preventDefault();
    setSrc(randomExpression());
    window.setTimeout(() => setSrc("/atpotato-normal.png"), 600);
  };

  const handleClick = () => {
    const now = Date.now();
    const streak = clickStreakRef.current;
    if (now - streak.last < 600) {
      streak.count += 1;
    } else {
      streak.count = 1;
    }
    streak.last = now;
    if (streak.count >= 5) {
      streak.count = 0;
      runExpressionCycle();
    }
  };

  const runExpressionCycle = () => {
    setShake(true);
    let i = 0;
    const seq = ["/atpotato-dead.png", "/atpotato-scawy.png", "/atpotato-kawaii.png", "/atpotato-waow.png"];
    const tick = () => {
      setSrc(seq[i % seq.length]);
      i += 1;
      if (i < seq.length * 2) {
        window.setTimeout(tick, 110);
      } else {
        setSrc("/atpotato-waow.png");
        window.setTimeout(() => setShake(false), 400);
      }
    };
    tick();
  };

  useEffect(() => {
    if (!follow) return;
    const onMove = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const max = 14;
      if (dist < 1) {
        setOffset({ x: 0, y: 0 });
        return;
      }
      const norm = Math.min(1, 220 / Math.max(dist, 220));
      setOffset({ x: (dx / dist) * max * norm, y: (dy / dist) * max * norm });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [follow]);

  return (
    <div
      ref={wrapRef}
      className={`relative inline-block select-none cursor-pointer ${float ? "mascot-float" : ""} ${className}`}
      style={
        {
          width: size,
          height: size,
          // expose tilt to the float keyframe
          ["--mascot-tilt" as string]: `${tilt}deg`,
          transform: `rotate(${tilt}deg)`,
        } as React.CSSProperties
      }
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onTouchStart={handleTouch}
      onClick={handleClick}
    >
      <img
        src={src}
        alt="atpotato mascot"
        draggable={false}
        className={`${thick ? "sticker-img-thick" : "sticker-img"} w-full h-full object-contain transition-transform`}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) ${shake ? "rotate(-4deg)" : ""}`,
          transition: "transform 120ms ease-out",
        }}
      />
    </div>
  );
}
