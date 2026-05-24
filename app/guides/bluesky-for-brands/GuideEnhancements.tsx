"use client";

import { useEffect } from "react";

export function GuideEnhancements() {
  useEffect(() => {
    const content = document.querySelector(".guide-content");
    if (!content) return;

    // Reading time
    const text = (content.textContent ?? "").trim();
    const minutes = Math.max(1, Math.ceil(text.split(/\s+/).length / 200));
    const rt = document.querySelector(".reading-time");
    if (rt) rt.innerHTML = `📚 ${minutes} min read`;

    // Table of contents
    const headings = Array.from(content.querySelectorAll("h2")) as HTMLElement[];
    if (!headings.length) return;

    const tocNav = document.createElement("nav");
    tocNav.className = "toc-container";
    tocNav.innerHTML = '<h2>Table of Contents</h2><ul class="toc-list"></ul>';
    const guideContainer = document.querySelector(".guide-container");
    guideContainer?.appendChild(tocNav);

    const toggleButton = document.createElement("button");
    toggleButton.className = "toc-toggle";
    toggleButton.innerHTML = "📑";
    document.body.appendChild(toggleButton);

    const overlay = document.createElement("div");
    overlay.className = "toc-overlay";
    const modal = document.createElement("div");
    modal.className = "toc-modal";
    modal.innerHTML = '<h2>Table of Contents</h2><ul class="toc-list"></ul>';
    const closeButton = document.createElement("button");
    closeButton.className = "toc-close";
    closeButton.innerHTML = "×";
    modal.appendChild(closeButton);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const showMobile = () => {
      document.body.style.overflow = "hidden";
      requestAnimationFrame(() => overlay.classList.add("active"));
    };
    const hideMobile = () => {
      overlay.classList.remove("active");
      window.setTimeout(() => {
        document.body.style.overflow = "";
      }, 300);
    };

    toggleButton.onclick = showMobile;
    closeButton.onclick = hideMobile;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideMobile();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideMobile();
    };
    document.addEventListener("keydown", onKey);

    const tocLists = document.querySelectorAll(".toc-list");
    tocLists.forEach((tocList) => {
      tocList.innerHTML = "";
      headings.forEach((heading, index) => {
        const id = `section-${index}`;
        heading.id = id;
        const li = document.createElement("li");
        li.className = "toc-item toc-h2";
        const link = document.createElement("a");
        link.href = `#${id}`;
        link.textContent = heading.textContent ?? "";
        link.className = "toc-link toc-h2";
        link.addEventListener("click", hideMobile);
        li.appendChild(link);
        tocList.appendChild(li);
      });
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = entry.target.getAttribute("id");
          if (!id) return;
          const links = document.querySelectorAll(`[href="#${id}"]`);
          if (entry.isIntersecting) {
            document.querySelectorAll(".toc-link").forEach((l) => l.classList.remove("active"));
            links.forEach((l) => l.classList.add("active"));
          }
        });
      },
      { rootMargin: "-100px 0px -66% 0px" }
    );
    headings.forEach((h) => io.observe(h));

    // Progress bar
    const progressContainer = document.createElement("div");
    progressContainer.className = "reading-progress";
    const progressBar = document.createElement("div");
    progressBar.className = "progress-bar";
    progressContainer.appendChild(progressBar);
    document.body.insertBefore(progressContainer, document.body.firstChild);

    const onScroll = () => {
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docH > 0 ? (window.scrollY / docH) * 100 : 0;
      progressBar.style.width = `${progress}%`;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("keydown", onKey);
      io.disconnect();
      tocNav.remove();
      toggleButton.remove();
      overlay.remove();
      progressContainer.remove();
    };
  }, []);

  return null;
}
