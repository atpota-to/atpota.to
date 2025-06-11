// Theme Management
class ThemeManager {
    constructor() {
        this.theme = localStorage.getItem('theme') || 'light';
        this.init();
    }

    init() {
        document.documentElement.setAttribute('data-theme', this.theme);
        this.createToggleButton();
    }

    createToggleButton() {
        const button = document.createElement('button');
        button.className = 'theme-toggle';
        button.innerHTML = this.theme === 'light' ? '🌚' : '🌞';
        button.onclick = () => this.toggleTheme();
        document.body.appendChild(button);
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        localStorage.setItem('theme', this.theme);
        document.documentElement.setAttribute('data-theme', this.theme);
        document.querySelector('.theme-toggle').innerHTML = this.theme === 'light' ? '🌚' : '🌞';
    }
}

// Initialize theme manager when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ThemeManager();
}); 