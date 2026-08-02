// Table of Contents
class TableOfContents {
    constructor(contentSelector = '.guide-content') {
        this.content = document.querySelector(contentSelector);
        this.headings = this.content.querySelectorAll('h2');
        this.tocContainer = null;
        this.tocOverlay = null;
        this.isAnimating = false;
        this.init();
    }

    init() {
        this.createTocContainer();
        this.createMobileElements();
        this.buildToc();
        this.initIntersectionObserver();
    }

    createTocContainer() {
        this.tocContainer = document.createElement('nav');
        this.tocContainer.className = 'toc-container';
        this.tocContainer.innerHTML = '<h2>Table of Contents</h2><ul class="toc-list"></ul>';
        document.querySelector('.guide-container').appendChild(this.tocContainer);
    }

    createMobileElements() {
        // Create toggle button
        const toggleButton = document.createElement('button');
        toggleButton.className = 'toc-toggle';
        toggleButton.innerHTML = '&#9776;';
        toggleButton.setAttribute('aria-label', 'Table of contents');
        toggleButton.onclick = () => this.showMobileToc();
        document.body.appendChild(toggleButton);

        // Create overlay
        this.tocOverlay = document.createElement('div');
        this.tocOverlay.className = 'toc-overlay';
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'toc-modal';
        modal.innerHTML = '<h2>Table of Contents</h2><ul class="toc-list"></ul>';
        
        // Create close button
        const closeButton = document.createElement('button');
        closeButton.className = 'toc-close';
        closeButton.innerHTML = '×';
        closeButton.onclick = () => this.hideMobileToc();
        modal.appendChild(closeButton);

        this.tocOverlay.appendChild(modal);
        document.body.appendChild(this.tocOverlay);

        // Close on overlay click
        this.tocOverlay.addEventListener('click', (e) => {
            if (e.target === this.tocOverlay) {
                this.hideMobileToc();
            }
        });

        // Close on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideMobileToc();
            }
        });
    }

    buildToc() {
        const tocLists = document.querySelectorAll('.toc-list');
        
        tocLists.forEach(tocList => {
            tocList.innerHTML = ''; // Clear existing items
            
            this.headings.forEach((heading, index) => {
                // Skip if heading is inside guide-header
                if (heading.closest('.guide-header')) return;
                
                const link = document.createElement('a');
                const listItem = document.createElement('li');
                const id = `section-${index}`;
                
                heading.id = id;
                link.href = `#${id}`;
                link.textContent = heading.textContent;
                link.className = `toc-link toc-${heading.tagName.toLowerCase()}`;
                
                // Add click handler for mobile
                link.addEventListener('click', () => {
                    this.hideMobileToc();
                });
                
                listItem.className = `toc-item toc-${heading.tagName.toLowerCase()}`;
                listItem.appendChild(link);
                tocList.appendChild(listItem.cloneNode(true));
            });
        });
    }

    showMobileToc() {
        if (this.isAnimating) return;
        this.isAnimating = true;
        
        // Prevent body scroll
        document.body.style.overflow = 'hidden';
        
        // Show overlay
        requestAnimationFrame(() => {
            this.tocOverlay.classList.add('active');
            
            // Reset animation state after transition
            setTimeout(() => {
                this.isAnimating = false;
            }, 300); // Match the CSS transition duration
        });
    }

    hideMobileToc() {
        if (this.isAnimating) return;
        this.isAnimating = true;
        
        // Hide overlay
        this.tocOverlay.classList.remove('active');
        
        // Re-enable body scroll after animation
        setTimeout(() => {
            document.body.style.overflow = '';
            this.isAnimating = false;
        }, 300); // Match the CSS transition duration
    }

    initIntersectionObserver() {
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    const id = entry.target.getAttribute('id');
                    const tocLinks = document.querySelectorAll(`[href="#${id}"]`);
                    
                    if (entry.isIntersecting) {
                        document.querySelectorAll('.toc-link').forEach(link => link.classList.remove('active'));
                        tocLinks.forEach(link => link.classList.add('active'));
                    }
                });
            },
            { rootMargin: '-100px 0px -66% 0px' }
        );

        this.headings.forEach(heading => observer.observe(heading));
    }
}

// Reading Progress — the growing bottom edge of the topbar. Measured against
// the article itself, so it reads 100% at the end of the guide rather than at
// the end of the footer.
class ReadingProgress {
    constructor(contentSelector = '.guide-content') {
        this.content = document.querySelector(contentSelector);
        this.bar = document.querySelector('.progress-bar');
        this.ticking = false;
        if (!this.content || !this.bar) return;
        this.init();
    }

    init() {
        const request = () => {
            if (this.ticking) return;
            this.ticking = true;
            requestAnimationFrame(() => { this.ticking = false; this.updateProgress(); });
        };
        window.addEventListener('scroll', request, { passive: true });
        window.addEventListener('resize', request, { passive: true });
        this.updateProgress();
    }

    updateProgress() {
        const start = this.content.getBoundingClientRect().top + window.scrollY;
        const end = start + this.content.offsetHeight - window.innerHeight;
        // a short article can end above where it starts; then it is simply
        // unread until you pass its top, and read once you do
        const p = end > start
            ? (window.scrollY - start) / (end - start)
            : (window.scrollY >= start ? 1 : 0);

        this.bar.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
    }
}

// Reading Time Estimator
class ReadingTimeEstimator {
    constructor(contentSelector = '.guide-content') {
        this.content = document.querySelector(contentSelector);
        this.wordsPerMinute = 200;
        this.init();
    }

    init() {
        const wordCount = this.countWords();
        const readingTime = Math.ceil(wordCount / this.wordsPerMinute);
        this.displayReadingTime(readingTime);
    }

    countWords() {
        const text = this.content.textContent || this.content.innerText;
        return text.trim().split(/\s+/).length;
    }

    displayReadingTime(minutes) {
        const readingTimeElement = document.querySelector('.reading-time');
        if (readingTimeElement) {
            readingTimeElement.textContent = `${minutes} min read`;
        }
    }
}

// Initialize all components when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Wait for markdown content to be loaded
    const checkContent = setInterval(() => {
        const content = document.querySelector('#markdown-content');
        if (content && content.children.length > 0) {
            clearInterval(checkContent);
            
            // Initialize components
            new TableOfContents();
            new ReadingProgress();
            new ReadingTimeEstimator();
        }
    }, 100);
}); 