// Array of all potato expressions
const potatoExpressions = [
    '/atpotato-dead.png',
    '/atpotato-waow.png',
    '/atpotato-scawy.png',
    '/atpotato-kawaii.png'
];

// Get a random potato expression
function getRandomExpression() {
    return potatoExpressions[Math.floor(Math.random() * potatoExpressions.length)];
}

// Handle logo hover effect
function initLogoHover() {
    // Target all logo variants
    const logos = document.querySelectorAll('.nav-logo, .logo, .home-logo');
    
    logos.forEach(logo => {
        const defaultSrc = '/atpotato-normal.png';
        let touchTimeout;
        
        // Set initial source
        logo.src = defaultSrc;
        
        // Add hover listeners for desktop
        logo.addEventListener('mouseenter', () => {
            logo.src = getRandomExpression();
        });
        
        logo.addEventListener('mouseleave', () => {
            logo.src = defaultSrc;
        });

        // Add touch listeners for mobile
        logo.addEventListener('touchstart', (e) => {
            // Prevent default to avoid any unwanted behaviors
            e.preventDefault();
            logo.src = getRandomExpression();
            
            // Reset to default after a short delay
            clearTimeout(touchTimeout);
            touchTimeout = setTimeout(() => {
                logo.src = defaultSrc;
            }, 500); // Reset after 500ms
        });

        // Clear timeout if touch is canceled
        logo.addEventListener('touchcancel', () => {
            clearTimeout(touchTimeout);
            logo.src = defaultSrc;
        });
    });
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initLogoHover); 