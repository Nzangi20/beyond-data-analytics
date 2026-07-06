const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken, requireRole, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticateToken, requirePasswordChanged, requireRole('mentor'));

// GET /api/mentor/dashboard
router.get('/dashboard', (req, res) => {
    try {
        const students = db.prepare(`
            SELECT u.id, u.username, u.full_name, u.email, ms.assigned_at
            FROM mentor_students ms
            JOIN users u ON ms.student_id = u.id
            WHERE ms.mentor_id = ? AND u.is_active = 1
            ORDER BY ms.assigned_at DESC
        `).all(req.user.id);

        // Get progress for each student
        students.forEach(s => {
            s.enrollments = db.prepare(`
                SELECT t.name as tutorial_name, t.slug,
                       COUNT(m.id) as total_modules,
                       SUM(CASE WHEN sp.status = 'completed' THEN 1 ELSE 0 END) as completed_modules,
                       ROUND(AVG(CASE WHEN sp.score IS NOT NULL THEN sp.score ELSE 0 END), 1) as avg_score
                FROM user_tutorials ut
                JOIN tutorials t ON ut.tutorial_id = t.id
                JOIN modules m ON m.tutorial_id = t.id
                LEFT JOIN student_progress sp ON sp.module_id = m.id AND sp.user_id = ?
                WHERE ut.user_id = ?
                GROUP BY t.id
            `).all(s.id, s.id);
        });

        res.json({ students });
    } catch (err) {
        console.error('Mentor dashboard error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/mentor/students/:id/progress
router.get('/students/:id/progress', (req, res) => {
    try {
        const student = db.prepare('SELECT id, username, full_name, email FROM users WHERE id = ?').get(req.params.id);
        if (!student) return res.status(404).json({ error: 'Student not found' });

        // Verify mentor-student relationship
        const assigned = db.prepare('SELECT * FROM mentor_students WHERE mentor_id = ? AND student_id = ?').get(req.user.id, req.params.id);
        if (!assigned) return res.status(403).json({ error: 'Student not assigned to you' });

        const progress = db.prepare(`
            SELECT sp.*, m.title as module_title, m.module_number, t.name as tutorial_name
            FROM student_progress sp
            JOIN modules m ON sp.module_id = m.id
            JOIN tutorials t ON m.tutorial_id = t.id
            WHERE sp.user_id = ?
            ORDER BY t.id, m.module_number
        `).all(req.params.id);

        const examHistory = db.prepare(`
            SELECT ea.*, e.title as exam_title, m.title as module_title
            FROM exam_attempts ea
            JOIN exams e ON ea.exam_id = e.id
            JOIN modules m ON e.module_id = m.id
            WHERE ea.user_id = ? AND ea.status IN ('completed', 'auto_submitted')
            ORDER BY ea.finished_at DESC
        `).all(req.params.id);

        res.json({ student, progress, examHistory });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/mentor/sessions - Get scheduled sessions
router.get('/sessions', (req, res) => {
    try {
        const sessions = db.prepare(`
            SELECT ms.*, u.full_name as student_name, u.username as student_username
            FROM mentorship_sessions ms
            JOIN users u ON ms.student_id = u.id
            WHERE ms.mentor_id = ?
            ORDER BY ms.schedule_date DESC
        `).all(req.user.id);
        res.json({ sessions });
    } catch (err) {
        console.error('Get sessions error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/mentor/sessions - Schedule a mentorship session
router.post('/sessions', (req, res) => {
    try {
        const { studentId, topic, scheduleDate, meetingLink } = req.body;
        if (!studentId || !topic || !scheduleDate) {
            return res.status(400).json({ error: 'Student, topic, and schedule date are required' });
        }

        // Verify assignment
        const assigned = db.prepare('SELECT id FROM mentor_students WHERE mentor_id = ? AND student_id = ?').get(req.user.id, studentId);
        if (!assigned) {
            return res.status(403).json({ error: 'Student is not assigned to you' });
        }

        db.prepare(`
            INSERT INTO mentorship_sessions (mentor_id, student_id, topic, schedule_date, meeting_link, status)
            VALUES (?, ?, ?, ?, ?, 'scheduled')
        `).run(req.user.id, studentId, topic, scheduleDate, meetingLink || null);

        // Notify student
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            studentId,
            'Mentorship Session Scheduled 📅',
            `Your mentor has scheduled a session: "${topic}" on ${scheduleDate}.`
        );

        res.status(201).json({ message: 'Session scheduled successfully' });
    } catch (err) {
        console.error('Schedule session error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/mentor/sessions/:id - Update session status
router.put('/sessions/:id', (req, res) => {
    try {
        const { status } = req.body;
        if (!status) return res.status(400).json({ error: 'Status is required' });

        const session = db.prepare('SELECT * FROM mentorship_sessions WHERE id = ?').get(req.params.id);
        if (!session || session.mentor_id !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('UPDATE mentorship_sessions SET status = ? WHERE id = ?').run(status, req.params.id);

        // Notify student
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            session.student_id,
            'Mentorship Session Updated 📅',
            `Your mentorship session "${session.topic}" status has been updated to: ${status}.`
        );

        res.json({ message: 'Session updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
