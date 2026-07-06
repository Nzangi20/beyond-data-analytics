const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken, requireRole, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticateToken, requirePasswordChanged, requireRole('student'));

// GET /api/student/dashboard
router.get('/dashboard', (req, res) => {
    try {
        const enrollments = db.prepare(`
            SELECT t.*, ut.enrolled_at, ut.learning_mode, ut.payment_status
            FROM user_tutorials ut
            JOIN tutorials t ON ut.tutorial_id = t.id
            WHERE ut.user_id = ?
            ORDER BY ut.enrolled_at DESC
        `).all(req.user.id);

        // Get progress for each enrollment
        const tutorials = enrollments.map(t => {
            const modules = db.prepare(`
                SELECT m.*, sp.status, sp.score, sp.attempts, sp.completed_at
                FROM modules m
                LEFT JOIN student_progress sp ON m.id = sp.module_id AND sp.user_id = ?
                WHERE m.tutorial_id = ?
                ORDER BY m.module_number
            `).all(req.user.id, t.id);

            // Ensure first module is always unlocked if not already started/completed
            modules.forEach(m => {
                if (m.module_number === 1 && (!m.status || m.status === 'locked')) {
                    m.status = 'unlocked';
                }
            });

            const completedModules = modules.filter(m => m.status === 'completed').length;
            const totalModules = modules.length;
            const completionPercentage = totalModules > 0 ? Math.round((completedModules / totalModules) * 100) : 0;

            // Fetch assigned instructors
            const instructors = db.prepare(`
                SELECT u.full_name, u.email
                FROM tutorial_instructors ti
                JOIN users u ON ti.instructor_id = u.id
                WHERE ti.tutorial_id = ?
            `).all(t.id);

            // Fetch assigned mentor
            const mentor = db.prepare(`
                SELECT u.full_name, u.email
                FROM mentor_students ms
                JOIN users u ON ms.mentor_id = u.id
                WHERE ms.student_id = ?
            `).get(req.user.id);

            return {
                ...t,
                modules,
                completedModules,
                totalModules,
                completionPercentage,
                instructors,
                mentor: mentor || null
            };
        });

        // Get certificates
        const certificates = db.prepare(`
            SELECT c.*, t.name as tutorial_name
            FROM certificates c
            JOIN tutorials t ON c.tutorial_id = t.id
            WHERE c.user_id = ?
            ORDER BY c.issued_at DESC
        `).all(req.user.id);

        // Get recent exam results
        const recentExams = db.prepare(`
            SELECT ea.*, e.title as exam_title, m.title as module_title, t.name as tutorial_name
            FROM exam_attempts ea
            JOIN exams e ON ea.exam_id = e.id
            JOIN modules m ON e.module_id = m.id
            JOIN tutorials t ON m.tutorial_id = t.id
            WHERE ea.user_id = ? AND ea.status IN ('completed', 'auto_submitted')
            ORDER BY ea.finished_at DESC
            LIMIT 10
        `).all(req.user.id);

        res.json({ tutorials, certificates, recentExams });
    } catch (err) {
        console.error('Student dashboard error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/student/tutorials/:slug
router.get('/tutorials/:slug', (req, res) => {
    try {
        const tutorial = db.prepare('SELECT * FROM tutorials WHERE slug = ?').get(req.params.slug);
        if (!tutorial) return res.status(404).json({ error: 'Tutorial not found' });

        // Check enrollment
        const enrolled = db.prepare('SELECT * FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, tutorial.id);
        if (!enrolled) return res.status(403).json({ error: 'Not enrolled in this tutorial' });

        const modules = db.prepare(`
            SELECT m.*, sp.status, sp.score, sp.attempts, sp.completed_at
            FROM modules m
            LEFT JOIN student_progress sp ON m.id = sp.module_id AND sp.user_id = ?
            WHERE m.tutorial_id = ?
            ORDER BY m.module_number
        `).all(req.user.id, tutorial.id);

        // Ensure first module is always unlocked if not already started/completed
        modules.forEach(m => {
            if (m.module_number === 1 && (!m.status || m.status === 'locked')) {
                m.status = 'unlocked';
            }
        });

        // Check for exams
        modules.forEach(m => {
            const exam = db.prepare('SELECT id, title, time_limit, total_marks FROM exams WHERE module_id = ? AND is_active = 1').get(m.id);
            m.hasExam = !!exam;
            m.examId = exam ? exam.id : null;
        });

        res.json({ tutorial, modules });
    } catch (err) {
        console.error('Tutorial detail error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/student/modules/:id/content
router.get('/modules/:id/content', (req, res) => {
    try {
        const module = db.prepare('SELECT m.*, t.name as tutorial_name, t.slug as tutorial_slug FROM modules m JOIN tutorials t ON m.tutorial_id = t.id WHERE m.id = ?').get(req.params.id);
        if (!module) return res.status(404).json({ error: 'Module not found' });

        // Check if module is unlocked
        let progress = db.prepare('SELECT * FROM student_progress WHERE user_id = ? AND module_id = ?').get(req.user.id, module.id);
        
        // If it's module 1 and there is no progress or it's marked as locked, initialize/unlock it!
        const isModule1 = module.module_number === 1;
        if (isModule1 && (!progress || progress.status === 'locked')) {
            if (!progress) {
                db.prepare("INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'unlocked')").run(req.user.id, module.id);
                progress = db.prepare('SELECT * FROM student_progress WHERE user_id = ? AND module_id = ?').get(req.user.id, module.id);
            } else {
                db.prepare("UPDATE student_progress SET status = 'unlocked' WHERE user_id = ? AND module_id = ?").run(req.user.id, module.id);
                progress.status = 'unlocked';
            }
        }

        if (!progress || progress.status === 'locked') {
            return res.status(403).json({ error: 'This module is locked. Complete the previous module first.' });
        }

        // Mark as in_progress if unlocked
        if (progress.status === 'unlocked') {
            db.prepare("UPDATE student_progress SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND module_id = ?").run(req.user.id, module.id);
            progress.status = 'in_progress';
        }

        const lessons = db.prepare('SELECT * FROM lessons WHERE module_id = ? AND is_active = 1 ORDER BY order_num').all(module.id);
        const exam = db.prepare('SELECT id, title, time_limit, total_marks, file_path FROM exams WHERE module_id = ? AND is_active = 1').get(module.id);

        // Group lessons by type
        const notes = lessons.filter(l => l.content_type === 'notes');
        const videos = lessons.filter(l => l.content_type === 'video');
        const exercises = lessons.filter(l => l.content_type === 'exercise');
        const materials = lessons.filter(l => l.content_type === 'material');

        res.json({
            module,
            progress,
            content: { notes, videos, exercises, materials },
            exam: exam || null
        });
    } catch (err) {
        console.error('Module content error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/student/workshops - Get scheduled workshops for enrolled courses
router.get('/workshops', (req, res) => {
    try {
        const workshops = db.prepare(`
            SELECT w.*, t.name as tutorial_name, u.full_name as instructor_name
            FROM workshops w
            JOIN tutorials t ON w.tutorial_id = t.id
            JOIN user_tutorials ut ON t.id = ut.tutorial_id
            LEFT JOIN users u ON w.instructor_id = u.id
            WHERE ut.user_id = ?
            ORDER BY w.schedule_date DESC
        `).all(req.user.id);
        res.json({ workshops });
    } catch (err) {
        console.error('Get student workshops error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/student/mentorship/sessions - Get scheduled sessions with their mentor
router.get('/mentorship/sessions', (req, res) => {
    try {
        const sessions = db.prepare(`
            SELECT ms.*, u.full_name as mentor_name, u.email as mentor_email
            FROM mentorship_sessions ms
            JOIN users u ON ms.mentor_id = u.id
            WHERE ms.student_id = ?
            ORDER BY ms.schedule_date DESC
        `).all(req.user.id);

        const mentor = db.prepare(`
            SELECT u.id, u.full_name, u.email
            FROM mentor_students ms
            JOIN users u ON ms.mentor_id = u.id
            WHERE ms.student_id = ?
        `).get(req.user.id);

        res.json({ sessions, mentor: mentor || null });
    } catch (err) {
        console.error('Get mentorship sessions error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/student/mentorship/sessions/request - Request a new mentorship session
router.post('/mentorship/sessions/request', (req, res) => {
    try {
        const { topic, scheduleDate } = req.body;
        if (!topic || !scheduleDate) {
            return res.status(400).json({ error: 'Topic and schedule date are required' });
        }

        // Get assigned mentor
        const mentor = db.prepare('SELECT mentor_id FROM mentor_students WHERE student_id = ?').get(req.user.id);
        if (!mentor) {
            return res.status(400).json({ error: 'No mentor assigned to you yet. Please request admin to assign one.' });
        }

        db.prepare(`
            INSERT INTO mentorship_sessions (mentor_id, student_id, topic, schedule_date, status)
            VALUES (?, ?, ?, ?, 'scheduled')
        `).run(mentor.mentor_id, req.user.id, topic, scheduleDate);

        // Notify mentor
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            mentor.mentor_id,
            'New Mentorship Session Requested 📅',
            `Student ${req.user.fullName || req.user.username} requested a session: "${topic}" on ${scheduleDate}.`
        );

        res.status(201).json({ message: 'Session requested successfully' });
    } catch (err) {
        console.error('Request session error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Multer Config for Assignment submissions
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const subStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'submissions');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage: subStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/student/available-programs - List all tutorials and enrollment statuses
router.get('/available-programs', (req, res) => {
    try {
        const tutorials = db.prepare('SELECT * FROM tutorials WHERE is_active = 1').all();
        const enrollments = db.prepare('SELECT * FROM user_tutorials WHERE user_id = ?').all(req.user.id);

        const list = tutorials.map(t => {
            const enrollment = enrollments.find(e => e.tutorial_id === t.id);
            return {
                ...t,
                enrolled: !!enrollment,
                learningMode: enrollment ? enrollment.learning_mode : null,
                paymentStatus: enrollment ? enrollment.payment_status : null
            };
        });

        res.json({ programs: list });
    } catch (err) {
        console.error('Get available programs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/student/enroll-self - Enroll in Self-Learning mode (free)
router.post('/enroll-self', (req, res) => {
    try {
        const { tutorialId } = req.body;
        if (!tutorialId) {
            return res.status(400).json({ error: 'Tutorial ID is required' });
        }

        const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tutorialId);
        if (!tutorial) return res.status(404).json({ error: 'Tutorial not found' });

        const existing = db.prepare('SELECT * FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, tutorialId);
        if (existing) {
            return res.status(400).json({ error: 'Already enrolled in this course' });
        }

        db.prepare("INSERT INTO user_tutorials (user_id, tutorial_id, learning_mode, payment_status) VALUES (?, ?, 'self', 'free')").run(req.user.id, tutorialId);

        // Unlock module 1
        const module1 = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = 1').get(tutorialId);
        if (module1) {
            db.prepare("INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'unlocked')").run(req.user.id, module1.id);
        }
        // Set other modules to locked
        const otherModules = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number > 1').all(tutorialId);
        otherModules.forEach(m => {
            db.prepare("INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'locked')").run(req.user.id, m.id);
        });

        // Notify user
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            req.user.id,
            'Self-Learning Course Started 📚',
            `You started ${tutorial.name} in Self-Learning mode.`
        );

        res.json({ message: 'Enrolled in Self-Learning mode successfully' });
    } catch (err) {
        console.error('Self enroll error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/student/assignments/:tutorialId - Fetch assignments and student submissions
router.get('/assignments/:tutorialId', (req, res) => {
    try {
        const tutorialId = parseInt(req.params.tutorialId);

        // Verify premium enrollment
        const enrollment = db.prepare('SELECT * FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, tutorialId);
        if (!enrollment || enrollment.learning_mode !== 'enrolled') {
            return res.status(403).json({ error: 'Assignments are only available for Premium Enrolled Learning Mode.' });
        }

        const list = db.prepare(`
            SELECT a.*, sa.submission_text, sa.file_path as submission_file, sa.grade, sa.feedback, sa.submitted_at, sa.graded_at
            FROM assignments a
            LEFT JOIN student_assignments sa ON a.id = sa.assignment_id AND sa.user_id = ?
            WHERE a.tutorial_id = ?
            ORDER BY a.created_at DESC
        `).all(req.user.id, tutorialId);

        res.json({ assignments: list });
    } catch (err) {
        console.error('Get assignments error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/student/assignments/submit - Submit assignment
router.post('/assignments/submit', upload.single('file'), (req, res) => {
    try {
        const { assignmentId, submissionText } = req.body;
        if (!assignmentId) {
            return res.status(400).json({ error: 'Assignment ID is required' });
        }

        const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
        if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

        // Verify premium enrollment
        const enrollment = db.prepare('SELECT * FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, assignment.tutorial_id);
        if (!enrollment || enrollment.learning_mode !== 'enrolled') {
            return res.status(403).json({ error: 'Assignments are only available for Premium Enrolled Learning Mode.' });
        }

        let filePath = null;
        if (req.file) {
            filePath = '/uploads/submissions/' + req.file.filename;
        }

        // Check if already submitted
        const existing = db.prepare('SELECT * FROM student_assignments WHERE assignment_id = ? AND user_id = ?').get(assignmentId, req.user.id);
        if (existing) {
            // Update submission
            db.prepare(`
                UPDATE student_assignments 
                SET submission_text = ?, file_path = COALESCE(?, file_path), submitted_at = CURRENT_TIMESTAMP 
                WHERE assignment_id = ? AND user_id = ?
            `).run(submissionText || null, filePath, assignmentId, req.user.id);
        } else {
            db.prepare(`
                INSERT INTO student_assignments (assignment_id, user_id, submission_text, file_path)
                VALUES (?, ?, ?, ?)
            `).run(assignmentId, req.user.id, submissionText || null, filePath);
        }

        // Notify instructors
        const instructors = db.prepare('SELECT instructor_id FROM tutorial_instructors WHERE tutorial_id = ?').all(assignment.tutorial_id);
        instructors.forEach(inst => {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                inst.instructor_id,
                'New Assignment Submission 📝',
                `Student ${req.user.fullName || req.user.username} submitted assignment: "${assignment.title}"`
            );
        });

        res.json({ message: 'Assignment submitted successfully' });
    } catch (err) {
        console.error('Submit assignment error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
