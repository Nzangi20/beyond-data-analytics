require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const { initializeDatabase } = require('./config/database');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Initialize database
initializeDatabase();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
['materials', 'videos', 'exercises'].forEach(sub => {
    const dir = path.join(uploadsDir, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: true, credentials: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/login', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { extensions: ['html', 'htm'] }));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/student', require('./routes/student'));
app.use('/api/tutorials', require('./routes/tutorials'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/certificates', require('./routes/certificates'));
app.use('/api/mentor', require('./routes/mentor'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/news', require('./routes/news'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/instructor', require('./routes/instructor'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/consultancy', require('./routes/consultancy'));

// SPA fallback - serve specific HTML pages
const publicDir = path.join(__dirname, '..', 'public');
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/change-password', (req, res) => res.sendFile(path.join(publicDir, 'change-password.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(publicDir, 'admin', req.params[0] || 'dashboard.html')));
app.get('/student/*', (req, res) => res.sendFile(path.join(publicDir, 'student', req.params[0] || 'dashboard.html')));
app.get('/mentor/*', (req, res) => res.sendFile(path.join(publicDir, 'mentor', req.params[0] || 'dashboard.html')));
app.get('/instructor/*', (req, res) => res.sendFile(path.join(publicDir, 'instructor', req.params[0] || 'dashboard.html')));

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     Beyond Data Analytics Platform Server        ║
║     Running on http://localhost:${PORT}              ║
║     Environment: ${process.env.NODE_ENV || 'development'}                  ║
╚══════════════════════════════════════════════════╝
    `);

    // Run automatic course importer asynchronously to avoid blocking port binding on Render
    setTimeout(() => {
        try {
            console.log('Running automatic course importer...');
            require('./utils/import_courses');
        } catch (importError) {
            console.error('Failed to run automatic course importer:', importError);
        }
    }, 1000);
});
