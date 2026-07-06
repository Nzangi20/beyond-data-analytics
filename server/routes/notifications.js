const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get all notifications for the logged-in user
router.get('/', authenticateToken, (req, res) => {
    try {
        const notifications = db.prepare(`
            SELECT * FROM notifications 
            WHERE user_id = ? OR role_id = ? OR (user_id IS NULL AND role_id IS NULL)
            ORDER BY created_at DESC 
            LIMIT 50
        `).all(req.user.id, req.user.roleId);

        res.json({ notifications });
    } catch (err) {
        console.error('Get notifications error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Mark all notifications for the logged-in user as read
router.post('/read-all', authenticateToken, (req, res) => {
    try {
        db.prepare(`
            UPDATE notifications 
            SET is_read = 1 
            WHERE user_id = ? OR role_id = ? OR (user_id IS NULL AND role_id IS NULL)
        `).run(req.user.id, req.user.roleId);

        res.json({ message: 'All notifications marked as read' });
    } catch (err) {
        console.error('Mark read notifications error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Mark a single notification as read
router.post('/:id/read', authenticateToken, (req, res) => {
    try {
        db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND (user_id = ? OR role_id = ? OR (user_id IS NULL AND role_id IS NULL))').run(
            req.params.id, req.user.id, req.user.roleId
        );
        res.json({ message: 'Notification marked as read' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
