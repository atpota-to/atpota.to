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
        
        // Set initial source
        logo.src = defaultSrc;
        
        // Add hover listeners
        logo.addEventListener('mouseenter', () => {
            logo.src = getRandomExpression();
        });
        
        logo.addEventListener('mouseleave', () => {
            logo.src = defaultSrc;
        });
    });
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initLogoHover); 