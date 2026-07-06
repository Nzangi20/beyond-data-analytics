const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const imagesDir = path.join(publicDir, 'images');
const legacyDir = path.join(rootDir, 'server', 'legacy');

// Ensure directories exist
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
}
if (!fs.existsSync(legacyDir)) {
    fs.mkdirSync(legacyDir, { recursive: true });
}

// 1. Move all images from root to public/images
const files = fs.readdirSync(rootDir);
const imageExtensions = ['.jpg', '.jpeg', '.png', '.jfif'];
const movedImages = [];

files.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (imageExtensions.includes(ext)) {
        const oldPath = path.join(rootDir, file);
        const newPath = path.join(imagesDir, file);
        fs.renameSync(oldPath, newPath);
        movedImages.push(file);
    }
});

console.log(`Moved ${movedImages.length} images to public/images/`);

// 2. Read and modify index.html
const indexHtmlPath = path.join(rootDir, 'index.html');
if (fs.existsSync(indexHtmlPath)) {
    let html = fs.readFileSync(indexHtmlPath, 'utf8');

    // Replace image references in HTML/CSS
    movedImages.forEach(imgName => {
        // Replace absolute or relative paths like url('image.jpg') or src="image.jpg"
        const regex = new RegExp(`(['"/]?)(${imgName})(['"\\) ]?)`, 'g');
        html = html.replace(regex, (match, before, name, after) => {
            // Check if it's already inside images/
            if (before === 'images/') return match;
            if (before === '/images/') return match;
            // Otherwise prepend /images/
            const prefix = before.endsWith('/') ? before.slice(0, -1) : before;
            return `${prefix}/images/${name}${after}`;
        });
    });

    // Add navigation dropdown style inside <style>
    const styleEndTag = '</style>';
    const dropdownCss = `
/* ==================== LMS DROPDOWN & LOGIN ==================== */
.nav-dropdown {
    position: relative;
    display: inline-block;
}
.dropdown-content {
    display: none;
    position: absolute;
    background-color: var(--primary-blue);
    min-width: 200px;
    box-shadow: var(--shadow-md);
    border-radius: 8px;
    z-index: 1001;
    top: 100%;
    left: 0;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.1);
}
.dropdown-content a {
    color: var(--white) !important;
    padding: 0.8rem 1.2rem !important;
    text-decoration: none;
    display: flex !important;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    transition: var(--transition);
    border-radius: 0 !important;
}
.dropdown-content a:hover {
    background: var(--gradient-3) !important;
    color: var(--primary-blue) !important;
}
.nav-dropdown:hover .dropdown-content {
    display: block;
}
.navbar-login-btn {
    background: var(--gradient-3);
    color: var(--primary-blue) !important;
    font-weight: 700 !important;
}
.navbar-login-btn:hover {
    background: var(--gradient-2) !important;
    color: var(--white) !important;
}
`;
    
    html = html.replace(styleEndTag, `${dropdownCss}\n${styleEndTag}`);

    // Modify navigation menu
    const navMenuTag = '<ul class="nav-menu" id="navMenu">';
    const newNavItems = `
        <li class="nav-dropdown">
            <a href="javascript:void(0)" class="dropdown-trigger"><i class="fas fa-graduation-cap"></i> Software Tutorials <i class="fas fa-caret-down" style="font-size:0.75rem; margin-left:0.25rem;"></i></a>
            <div class="dropdown-content">
                <a href="/login.html?redirect=/student/tutorials.html?slug=python"><i class="fab fa-python" style="color:var(--vibrant-yellow);"></i> Python for Data Science</a>
                <a href="/login.html?redirect=/student/tutorials.html?slug=r-programming"><i class="fas fa-r-project" style="color:var(--accent-blue);"></i> R Programming</a>
                <a href="/login.html?redirect=/student/tutorials.html?slug=sql"><i class="fas fa-database" style="color:var(--golden-yellow);"></i> SQL & Databases</a>
                <a href="/login.html?redirect=/student/tutorials.html?slug=power-bi"><i class="fas fa-chart-bar" style="color:var(--bold-red);"></i> Power BI Dashboards</a>
            </div>
        </li>
        <li id="loginNav"><a href="/login.html" class="navbar-login-btn"><i class="fas fa-sign-in-alt"></i> Login</a></li>
`;

    html = html.replace(navMenuTag, `${navMenuTag}\n${newNavItems}`);

    // Add Javascript to update login link to Dashboard if user is logged in
    const bodyEndTag = '</body>';
    const loginStatusScript = `
<script>
    // Update navigation login button if user is already logged in
    (function() {
        const token = localStorage.getItem('token');
        const userJson = localStorage.getItem('user');
        if (token && userJson) {
            try {
                const user = JSON.parse(userJson);
                const loginNav = document.getElementById('loginNav');
                if (loginNav) {
                    let dashboardUrl = '/student/dashboard.html';
                    if (user.roleName === 'admin') dashboardUrl = '/admin/dashboard.html';
                    else if (user.roleName === 'mentor') dashboardUrl = '/mentor/dashboard.html';
                    loginNav.innerHTML = \`<a href="\${dashboardUrl}" class="navbar-login-btn"><i class="fas fa-tachometer-alt"></i> Dashboard</a>\`;
                }
            } catch (e) {
                console.error('Error parsing login user info:', e);
            }
        }
    })();
</script>
`;

    html = html.replace(bodyEndTag, `${loginStatusScript}\n${bodyEndTag}`);

    // Write modified file to public/index.html
    fs.writeFileSync(path.join(publicDir, 'index.html'), html, 'utf8');
    console.log('Modified index.html and saved to public/index.html');

    // Move original index.html and bdapp.py to server/legacy
    fs.renameSync(indexHtmlPath, path.join(legacyDir, 'index.html'));
    console.log('Moved original index.html to server/legacy/');
}

const bdappPath = path.join(rootDir, 'bdapp.py');
if (fs.existsSync(bdappPath)) {
    fs.renameSync(bdappPath, path.join(legacyDir, 'bdapp.py'));
    console.log('Moved bdapp.py to server/legacy/');
}
