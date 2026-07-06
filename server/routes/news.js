const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Optional file upload configuration for news & announcements
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'materials');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });


// Public route: Get all news articles
router.get('/articles', (req, res) => {
    try {
        const articles = db.prepare(`
            SELECT n.*, u.full_name as author_name 
            FROM news_articles n
            JOIN users u ON n.author_id = u.id
            WHERE n.is_published = 1
            ORDER BY n.created_at DESC
        `).all();
        res.json({ articles });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route: Get active announcements
router.get('/announcements', (req, res) => {
    try {
        const announcements = db.prepare(`
            SELECT * FROM announcements 
            WHERE is_active = 1 AND (expiry_date IS NULL OR expiry_date > datetime('now', 'localtime'))
            ORDER BY priority DESC, created_at DESC
        `).all();
        res.json({ announcements });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ADMIN CRUD ROUTES ====================

// Create news article
router.post('/articles', authenticateToken, requireRole('admin'), upload.single('file'), (req, res) => {
    try {
        const { title, content, category, isPublished } = req.body;
        if (!title || !content || !category) {
            return res.status(400).json({ error: 'Title, content, and category are required' });
        }

        let filePath = null;
        if (req.file) {
            filePath = '/uploads/materials/' + req.file.filename;
        }

        const result = db.prepare(`
            INSERT INTO news_articles (title, content, category, author_id, is_published, file_path)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(title, content, category, req.user.id, isPublished !== undefined ? parseInt(isPublished) : 1, filePath);

        // Notify all users about new general/course updates
        db.prepare('INSERT INTO notifications (title, message) VALUES (?, ?)').run(
            `News: ${title}`,
            `A new article in "${category}" was published: "${content.substring(0, 80)}..."`
        );

        res.status(201).json({ message: 'News article created', articleId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create article error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update news article
router.put('/articles/:id', authenticateToken, requireRole('admin'), (req, res) => {
    try {
        const { title, content, category, isPublished } = req.body;
        const article = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
        if (!article) return res.status(404).json({ error: 'Article not found' });

        db.prepare(`
            UPDATE news_articles 
            SET title = ?, content = ?, category = ?, is_published = ?
            WHERE id = ?
        `).run(
            title || article.title,
            content || article.content,
            category || article.category,
            isPublished !== undefined ? isPublished : article.is_published,
            req.params.id
        );

        res.json({ message: 'News article updated' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete news article
router.delete('/articles/:id', authenticateToken, requireRole('admin'), (req, res) => {
    try {
        db.prepare('DELETE FROM news_articles WHERE id = ?').run(req.params.id);
        res.json({ message: 'News article deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Create announcement
router.post('/announcements', authenticateToken, requireRole('admin'), upload.single('file'), (req, res) => {
    try {
        const { title, content, priority, expiryDate, linkUrl, imagePath } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }

        let filePath = req.body.filePath || null;
        if (req.file) {
            filePath = '/uploads/materials/' + req.file.filename;
        }

        const result = db.prepare(`
            INSERT INTO announcements (title, content, priority, expiry_date, link_url, image_path, file_path)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(title, content, priority || 'Medium', expiryDate || null, linkUrl || null, imagePath || null, filePath);

        // Broadcast to all users
        db.prepare('INSERT INTO notifications (title, message) VALUES (?, ?)').run(
            `[Announcement] ${title}`,
            `Priority: ${priority || 'Medium'} | ${content}`
        );

        // Log action
        db.prepare('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)').run(
            req.user.id, 'announcement_created', `Announcement: ${title} (${priority || 'Medium'})`
        );

        res.status(201).json({ message: 'Announcement created', announcementId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create announcement error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete announcement
router.delete('/announcements/:id', authenticateToken, requireRole('admin'), (req, res) => {
    try {
        db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
        res.json({ message: 'Announcement deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
