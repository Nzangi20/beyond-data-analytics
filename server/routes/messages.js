const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// GET /api/messages/inbox - Get incoming messages
router.get('/inbox', (req, res) => {
    try {
        const inbox = db.prepare(`
            SELECT m.*, u.full_name as sender_name, r.name as sender_role
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            JOIN roles r ON u.role_id = r.id
            WHERE m.receiver_id = ?
            ORDER BY m.created_at DESC
        `).all(req.user.id);
        res.json({ messages: inbox });
    } catch (err) {
        console.error('Inbox error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/messages/sent - Get sent messages
router.get('/sent', (req, res) => {
    try {
        const sent = db.prepare(`
            SELECT m.*, u.full_name as receiver_name, r.name as receiver_role
            FROM messages m
            JOIN users u ON m.receiver_id = u.id
            JOIN roles r ON u.role_id = r.id
            WHERE m.sender_id = ?
            ORDER BY m.created_at DESC
        `).all(req.user.id);
        res.json({ messages: sent });
    } catch (err) {
        console.error('Sent messages error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/messages/send - Send a message
router.post('/send', (req, res) => {
    try {
        const { receiverId, subject, messageText } = req.body;
        if (!receiverId || !messageText) {
            return res.status(400).json({ error: 'Recipient and message body are required' });
        }

        db.prepare(`
            INSERT INTO messages (sender_id, receiver_id, subject, message_text)
            VALUES (?, ?, ?, ?)
        `).run(req.user.id, receiverId, subject || 'No Subject', messageText);

        // Add a notification for receiver
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            receiverId,
            'New Message Received',
            `You received a new message from ${req.user.fullName || req.user.username}`
        );

        res.status(201).json({ message: 'Message sent successfully' });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/messages/read/:id - Mark message as read
router.post('/read/:id', (req, res) => {
    try {
        db.prepare('UPDATE messages SET is_read = 1 WHERE id = ? AND receiver_id = ?').run(req.params.id, req.user.id);
        res.json({ message: 'Message marked as read' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/messages/contacts - Get all available messaging contacts for logged in user
router.get('/contacts', (req, res) => {
    try {
        let contacts = [];
        const role = req.user.role;

        if (role === 'admin') {
            // Admins can message anyone
            contacts = db.prepare(`
                SELECT u.id, u.full_name, u.username, r.name as role_name 
                FROM users u 
                JOIN roles r ON u.role_id = r.id 
                WHERE u.id != ? AND u.is_active = 1
                ORDER BY r.id, u.full_name
            `).all(req.user.id);
        } else if (role === 'student') {
            // Students can message:
            // 1. Their assigned mentor
            const mentor = db.prepare(`
                SELECT u.id, u.full_name, u.username, 'Mentor' as role_name
                FROM mentor_students ms
                JOIN users u ON ms.mentor_id = u.id
                WHERE ms.student_id = ? AND u.is_active = 1
            `).all(req.user.id);

            // 2. Instructors of courses they are enrolled in
            const instructors = db.prepare(`
                SELECT DISTINCT u.id, u.full_name, u.username, 'Instructor' as role_name
                FROM user_tutorials ut
                JOIN tutorial_instructors ti ON ut.tutorial_id = ti.tutorial_id
                JOIN users u ON ti.instructor_id = u.id
                WHERE ut.user_id = ? AND u.is_active = 1
            `).all(req.user.id);

            // 3. Admins
            const admins = db.prepare(`
                SELECT u.id, u.full_name, u.username, 'Admin' as role_name
                FROM users u
                WHERE u.role_id = 1 AND u.is_active = 1
            `).all();

            contacts = [...mentor, ...instructors, ...admins];
        } else if (role === 'mentor') {
            // Mentors can message:
            // 1. Assigned students
            const students = db.prepare(`
                SELECT u.id, u.full_name, u.username, 'Student' as role_name
                FROM mentor_students ms
                JOIN users u ON ms.student_id = u.id
                WHERE ms.mentor_id = ? AND u.is_active = 1
            `).all(req.user.id);

            // 2. Admins
            const admins = db.prepare(`
                SELECT u.id, u.full_name, u.username, 'Admin' as role_name
                FROM users u
                WHERE u.role_id = 1 AND u.is_active = 1
            `).all();

            contacts = [...students, ...admins];
        } else if (role === 'instructor') {
            // Instructors can message:
            // 1. Students enrolled in their tutorials
            const students = db.prepare(`
                SELECT DISTINCT u.id, u.full_name, u.username, 'Student' as role_name
                FROM tutorial_instructors ti
                JOIN user_tutorials ut ON ti.tutorial_id = ut.tutorial_id
                JOIN users u ON ut.user_id = u.id
                WHERE ti.instructor_id = ? AND u.is_active = 1
            `).all(req.user.id);

            // 2. Admins
            const admins = db.prepare(`
                SELECT u.id, u.full_name, u.username, 'Admin' as role_name
                FROM users u
                WHERE u.role_id = 1 AND u.is_active = 1
            `).all();

            contacts = [...students, ...admins];
        }

        // De-duplicate contacts just in case
        const seen = new Set();
        const uniqueContacts = contacts.filter(c => {
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
        });

        res.json({ contacts: uniqueContacts });
    } catch (err) {
        console.error('Get contacts error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
