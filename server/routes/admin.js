const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../config/database');
const { authenticateToken, requireRole, requirePasswordChanged } = require('../middleware/auth');

// Apply auth to all admin routes
router.use(authenticateToken, requirePasswordChanged, requireRole('admin'));

// File upload config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let subDir = 'materials';
        if (file.mimetype.startsWith('video/')) subDir = 'videos';
        const dir = path.join(__dirname, '..', 'uploads', subDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ==================== DASHBOARD STATS ====================
router.get('/stats', (req, res) => {
    try {
        const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        const activeStudents = db.prepare('SELECT COUNT(*) as count FROM users WHERE role_id = 2 AND is_active = 1').get().count;
        const totalMentors = db.prepare('SELECT COUNT(*) as count FROM users WHERE role_id = 3 AND is_active = 1').get().count;
        const totalAttempts = db.prepare("SELECT COUNT(*) as count FROM exam_attempts WHERE status = 'completed'").get().count;
        const avgScore = db.prepare("SELECT AVG(percentage) as avg FROM exam_attempts WHERE status = 'completed'").get().avg || 0;
        const passRate = db.prepare("SELECT COUNT(*) as count FROM exam_attempts WHERE status = 'completed' AND percentage >= 70").get().count;
        const totalCerts = db.prepare('SELECT COUNT(*) as count FROM certificates').get().count;

        // Centralized financial calculations
        const certRevenue = db.prepare("SELECT SUM(amount) as sum FROM payments WHERE target_type = 'certificate' AND status = 'completed'").get().sum || 0;
        const enrollmentRevenue = db.prepare("SELECT SUM(amount) as sum FROM payments WHERE target_type = 'enrollment' AND status = 'completed'").get().sum || 0;
        const totalRevenue = certRevenue + enrollmentRevenue;

        const recentActivity = db.prepare(`
            SELECT al.*, u.username, u.full_name 
            FROM activity_logs al 
            LEFT JOIN users u ON al.user_id = u.id 
            ORDER BY al.created_at DESC LIMIT 20
        `).all();

        const recentUsers = db.prepare(`
            SELECT u.*, r.name as role_name 
            FROM users u JOIN roles r ON u.role_id = r.id 
            ORDER BY u.created_at DESC LIMIT 10
        `).all();

        res.json({
            stats: {
                totalUsers,
                activeStudents,
                totalMentors,
                totalAttempts,
                avgScore: Math.round(avgScore * 10) / 10,
                passRate: totalAttempts > 0 ? Math.round((passRate / totalAttempts) * 100) : 0,
                totalCerts,
                certRevenue,
                enrollmentRevenue,
                totalRevenue
            },
            recentActivity,
            recentUsers
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== USER MANAGEMENT ====================
router.get('/users', (req, res) => {
    try {
        const users = db.prepare(`
            SELECT u.id, u.username, u.email, u.full_name, u.is_active, u.first_login,
                   u.created_at, r.name as role_name, r.id as role_id,
                   creator.full_name as created_by_name
            FROM users u 
            JOIN roles r ON u.role_id = r.id 
            LEFT JOIN users creator ON u.created_by = creator.id
            ORDER BY u.created_at DESC
        `).all();
        res.json({ users });
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/users', (req, res) => {
    try {
        const { username, email, fullName, password, roleId } = req.body;
        if (!username || !fullName || !password) {
            return res.status(400).json({ error: 'Username, full name, and password are required' });
        }

        const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (exists) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        if (email) {
            const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
            if (emailExists) {
                return res.status(409).json({ error: 'Email already exists' });
            }
        }

        const hash = bcrypt.hashSync(password, 12);
        const result = db.prepare(`
            INSERT INTO users (username, email, full_name, password_hash, role_id, first_login, created_by)
            VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(username, email || null, fullName, hash, roleId || 2, req.user.id);

        db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
            req.user.id, 'user_created', `Created user: ${username} (role: ${roleId || 2})`, req.ip
        );

        res.status(201).json({ message: 'User created successfully', userId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/users/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { email, fullName, roleId, isActive } = req.body;

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        db.prepare(`
            UPDATE users SET email = ?, full_name = ?, role_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(email || user.email, fullName || user.full_name, roleId || user.role_id, 
               isActive !== undefined ? isActive : user.is_active, id);

        res.json({ message: 'User updated successfully' });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/users/:id', (req, res) => {
    try {
        const { id } = req.params;
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        db.prepare('UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        res.json({ message: 'User deactivated successfully' });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/users/:id/reset-password', (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;
        const password = newPassword || 'TempPass@2025';
        const hash = bcrypt.hashSync(password, 12);
        db.prepare('UPDATE users SET password_hash = ?, first_login = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, id);
        res.json({ message: 'Password reset successfully', temporaryPassword: password });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== ENROLLMENT ====================
router.post('/enroll', (req, res) => {
    try {
        const { userId, tutorialId } = req.body;
        if (!userId || !tutorialId) {
            return res.status(400).json({ error: 'User ID and Tutorial ID are required' });
        }
        
        db.prepare('INSERT OR IGNORE INTO user_tutorials (user_id, tutorial_id) VALUES (?, ?)').run(userId, tutorialId);
        
        // Unlock module 1 for this tutorial
        const module1 = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = 1').get(tutorialId);
        if (module1) {
            db.prepare('INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, "unlocked")').run(userId, module1.id);
        }
        // Set remaining modules as locked
        const otherModules = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number > 1').all(tutorialId);
        otherModules.forEach(m => {
            db.prepare('INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, "locked")').run(userId, m.id);
        });

        res.json({ message: 'Student enrolled successfully' });
    } catch (err) {
        console.error('Enroll error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== CONTENT MANAGEMENT ====================
router.get('/tutorials', (req, res) => {
    try {
        const tutorials = db.prepare('SELECT * FROM tutorials ORDER BY id').all();
        res.json({ tutorials });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/tutorials/:id/fee', (req, res) => {
    try {
        const { certificateFee, enrollmentFee } = req.body;
        db.prepare('UPDATE tutorials SET certificate_fee = ?, enrollment_fee = ? WHERE id = ?')
            .run(certificateFee, enrollmentFee, req.params.id);
        res.json({ message: 'Pricing fees updated successfully' });
    } catch (err) {
        console.error('Update fee error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/tutorials/:id/modules', (req, res) => {
    try {
        const modules = db.prepare('SELECT * FROM modules WHERE tutorial_id = ? ORDER BY module_number').all(req.params.id);
        res.json({ modules });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/modules', (req, res) => {
    try {
        const { tutorialId, moduleNumber, title, description, passMark } = req.body;
        if (!tutorialId || !moduleNumber || !title) {
            return res.status(400).json({ error: 'Tutorial ID, module number, and title are required' });
        }
        
        const exists = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = ?').get(tutorialId, moduleNumber);
        if (exists) {
            return res.status(400).json({ error: `Module number ${moduleNumber} already exists for this tutorial.` });
        }

        const result = db.prepare(`
            INSERT INTO modules (tutorial_id, module_number, title, description, pass_mark)
            VALUES (?, ?, ?, ?, ?)
        `).run(tutorialId, moduleNumber, title, description || null, passMark || 70);

        res.status(201).json({ message: 'Module created successfully', moduleId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create module error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/modules/:id', (req, res) => {
    try {
        const { title, description, passMark, isActive, moduleNumber, tutorialId } = req.body;
        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }

        if (tutorialId && moduleNumber) {
            const exists = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = ? AND id != ?').get(tutorialId, moduleNumber, req.params.id);
            if (exists) {
                return res.status(400).json({ error: `Module number ${moduleNumber} already exists for this tutorial.` });
            }
        }

        db.prepare(`
            UPDATE modules 
            SET title = ?, description = ?, pass_mark = ?, is_active = ?, module_number = COALESCE(?, module_number)
            WHERE id = ?
        `).run(title, description || null, passMark || 70, isActive !== undefined ? isActive : 1, moduleNumber || null, req.params.id);

        res.json({ message: 'Module updated successfully' });
    } catch (err) {
        console.error('Update module error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/modules/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM modules WHERE id = ?').run(req.params.id);
        res.json({ message: 'Module deleted successfully' });
    } catch (err) {
        console.error('Delete module error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/modules/:id/lessons', (req, res) => {
    try {
        const lessons = db.prepare('SELECT * FROM lessons WHERE module_id = ? ORDER BY order_num').all(req.params.id);
        res.json({ lessons });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/lessons', upload.single('file'), (req, res) => {
    try {
        const { moduleId, title, contentType, contentText } = req.body;
        if (!moduleId || !title || !contentType) {
            return res.status(400).json({ error: 'Module ID, title, and content type are required' });
        }

        const maxOrder = db.prepare('SELECT MAX(order_num) as max FROM lessons WHERE module_id = ?').get(moduleId).max || 0;

        let filePath = null, fileName = null;
        if (req.file) {
            filePath = '/uploads/' + (req.file.mimetype.startsWith('video/') ? 'videos/' : 'materials/') + req.file.filename;
            fileName = req.file.originalname;
        }

        const result = db.prepare(`
            INSERT INTO lessons (module_id, title, content_type, content_text, file_path, file_name, order_num)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(moduleId, title, contentType, contentText || null, filePath, fileName, maxOrder + 1);

        res.status(201).json({ message: 'Lesson created', lessonId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create lesson error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/lessons/:id', upload.single('file'), (req, res) => {
    try {
        const { title, contentType, contentText } = req.body;
        if (!title || !contentType) {
            return res.status(400).json({ error: 'Title and content type are required' });
        }

        const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
        if (!lesson) {
            return res.status(404).json({ error: 'Lesson not found' });
        }

        let filePath = lesson.file_path;
        let fileName = lesson.file_name;

        if (req.file) {
            // Delete old file if exists
            if (lesson.file_path) {
                const fullPath = path.join(__dirname, '..', lesson.file_path);
                if (fs.existsSync(fullPath)) {
                    try { fs.unlinkSync(fullPath); } catch (e) { console.error('Error deleting old file:', e); }
                }
            }
            filePath = '/uploads/' + (req.file.mimetype.startsWith('video/') ? 'videos/' : 'materials/') + req.file.filename;
            fileName = req.file.originalname;
        }

        db.prepare(`
            UPDATE lessons 
            SET title = ?, content_type = ?, content_text = ?, file_path = ?, file_name = ?
            WHERE id = ?
        `).run(title, contentType, contentText || null, filePath, fileName, req.params.id);

        res.json({ message: 'Lesson updated successfully' });
    } catch (err) {
        console.error('Update lesson error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/lessons/:id', (req, res) => {
    try {
        const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
        if (lesson && lesson.file_path) {
            const fullPath = path.join(__dirname, '..', lesson.file_path);
            if (fs.existsSync(fullPath)) {
                try { fs.unlinkSync(fullPath); } catch (e) { console.error('Error deleting file:', e); }
            }
        }
        db.prepare('DELETE FROM lessons WHERE id = ?').run(req.params.id);
        res.json({ message: 'Lesson deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== EXAM MANAGEMENT ====================
router.get('/exams', (req, res) => {
    try {
        const exams = db.prepare(`
            SELECT e.*, m.title as module_title, m.module_number, t.name as tutorial_name
            FROM exams e 
            JOIN modules m ON e.module_id = m.id 
            JOIN tutorials t ON m.tutorial_id = t.id
            ORDER BY t.id, m.module_number
        `).all();
        res.json({ exams });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/exams', (req, res) => {
    try {
        const { moduleId, title, description, timeLimit, totalMarks } = req.body;
        if (!moduleId || !title) {
            return res.status(400).json({ error: 'Module ID and title are required' });
        }
        const result = db.prepare(`
            INSERT INTO exams (module_id, title, description, time_limit, total_marks)
            VALUES (?, ?, ?, ?, ?)
        `).run(moduleId, title, description || null, timeLimit || 60, totalMarks || 100);
        res.status(201).json({ message: 'Exam created', examId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create exam error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/exams/:id', (req, res) => {
    try {
        const { title, description, timeLimit, totalMarks, isActive } = req.body;
        db.prepare(`
            UPDATE exams SET title = ?, description = ?, time_limit = ?, total_marks = ?, is_active = ?
            WHERE id = ?
        `).run(title, description, timeLimit, totalMarks, isActive !== undefined ? isActive : 1, req.params.id);
        res.json({ message: 'Exam updated' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/exams/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);
        res.json({ message: 'Exam deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== QUESTION MANAGEMENT ====================
router.get('/exams/:examId/questions', (req, res) => {
    try {
        const questions = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY order_num').all(req.params.examId);
        questions.forEach(q => {
            q.answers = db.prepare('SELECT * FROM answers WHERE question_id = ? ORDER BY order_num').all(q.id);
        });
        res.json({ questions });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/questions', (req, res) => {
    try {
        const { examId, questionText, questionType, marks, explanation, answers } = req.body;
        if (!examId || !questionText || !questionType) {
            return res.status(400).json({ error: 'Exam ID, question text, and type are required' });
        }
        if (!answers || answers.length < 2) {
            return res.status(400).json({ error: 'At least 2 answer options are required' });
        }

        const maxOrder = db.prepare('SELECT MAX(order_num) as max FROM questions WHERE exam_id = ?').get(examId).max || 0;
        const result = db.prepare(`
            INSERT INTO questions (exam_id, question_text, question_type, marks, explanation, order_num)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(examId, questionText, questionType, marks || 1, explanation || null, maxOrder + 1);

        const qId = result.lastInsertRowid;
        const insertAnswer = db.prepare('INSERT INTO answers (question_id, answer_text, is_correct, order_num) VALUES (?, ?, ?, ?)');
        answers.forEach((a, i) => {
            insertAnswer.run(qId, a.text, a.isCorrect ? 1 : 0, i + 1);
        });

        res.status(201).json({ message: 'Question created', questionId: qId });
    } catch (err) {
        console.error('Create question error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.put('/questions/:id', (req, res) => {
    try {
        const { questionText, questionType, marks, explanation, answers } = req.body;
        db.prepare('UPDATE questions SET question_text = ?, question_type = ?, marks = ?, explanation = ? WHERE id = ?')
            .run(questionText, questionType, marks, explanation || null, req.params.id);

        if (answers) {
            db.prepare('DELETE FROM answers WHERE question_id = ?').run(req.params.id);
            const insertAnswer = db.prepare('INSERT INTO answers (question_id, answer_text, is_correct, order_num) VALUES (?, ?, ?, ?)');
            answers.forEach((a, i) => {
                insertAnswer.run(req.params.id, a.text, a.isCorrect ? 1 : 0, i + 1);
            });
        }
        res.json({ message: 'Question updated' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/questions/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
        res.json({ message: 'Question deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== REPORTS ====================
router.get('/reports/exams', (req, res) => {
    try {
        const examStats = db.prepare(`
            SELECT e.title as exam_title, m.title as module_title, t.name as tutorial_name,
                   COUNT(ea.id) as total_attempts,
                   ROUND(AVG(ea.percentage), 1) as avg_score,
                   SUM(CASE WHEN ea.percentage >= 70 THEN 1 ELSE 0 END) as passed,
                   SUM(CASE WHEN ea.percentage < 70 THEN 1 ELSE 0 END) as failed
            FROM exams e
            JOIN modules m ON e.module_id = m.id
            JOIN tutorials t ON m.tutorial_id = t.id
            LEFT JOIN exam_attempts ea ON e.id = ea.exam_id AND ea.status IN ('completed', 'auto_submitted')
            GROUP BY e.id
            ORDER BY t.id, m.module_number
        `).all();
        res.json({ examStats });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

router.get('/reports/activity', (req, res) => {
    try {
        const logs = db.prepare(`
            SELECT al.*, u.username, u.full_name 
            FROM activity_logs al 
            LEFT JOIN users u ON al.user_id = u.id 
            ORDER BY al.created_at DESC 
            LIMIT 100
        `).all();
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/assignments - Get instructors, mentors, students and current assignments
router.get('/assignments', (req, res) => {
    try {
        const instructors = db.prepare('SELECT id, full_name, username FROM users WHERE role_id = 6 AND is_active = 1').all();
        const mentors = db.prepare('SELECT id, full_name, username FROM users WHERE role_id = 3 AND is_active = 1').all();
        const students = db.prepare('SELECT id, full_name, username FROM users WHERE role_id = 2 AND is_active = 1').all();
        const tutorials = db.prepare('SELECT id, name FROM tutorials WHERE is_active = 1').all();

        const instructorAssignments = db.prepare(`
            SELECT ti.*, t.name as tutorial_name, u.full_name as instructor_name
            FROM tutorial_instructors ti
            JOIN tutorials t ON ti.tutorial_id = t.id
            JOIN users u ON ti.instructor_id = u.id
        `).all();

        const mentorAssignments = db.prepare(`
            SELECT ms.*, mentor.full_name as mentor_name, student.full_name as student_name
            FROM mentor_students ms
            JOIN users mentor ON ms.mentor_id = mentor.id
            JOIN users student ON ms.student_id = student.id
        `).all();

        res.json({
            instructors,
            mentors,
            students,
            tutorials,
            instructorAssignments,
            mentorAssignments
        });
    } catch (err) {
        console.error('Get assignments error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/assign-instructor - Assign instructor to tutorial
router.post('/assign-instructor', (req, res) => {
    try {
        const { instructorId, tutorialId } = req.body;
        if (!instructorId || !tutorialId) {
            return res.status(400).json({ error: 'Instructor ID and Tutorial ID are required' });
        }

        db.prepare('INSERT OR IGNORE INTO tutorial_instructors (tutorial_id, instructor_id) VALUES (?, ?)').run(tutorialId, instructorId);
        
        // Notify instructor
        const tutorial = db.prepare('SELECT name FROM tutorials WHERE id = ?').get(tutorialId);
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            instructorId,
            'New Course Assignment 📚',
            `You have been assigned to manage the course: "${tutorial ? tutorial.name : 'Unknown'}"`
        );

        res.json({ message: 'Instructor assigned successfully' });
    } catch (err) {
        console.error('Assign instructor error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/unassign-instructor - Unassign instructor from tutorial
router.post('/unassign-instructor', (req, res) => {
    try {
        const { instructorId, tutorialId } = req.body;
        db.prepare('DELETE FROM tutorial_instructors WHERE tutorial_id = ? AND instructor_id = ?').run(tutorialId, instructorId);
        res.json({ message: 'Instructor unassigned successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/assign-mentor - Assign mentor to student
router.post('/assign-mentor', (req, res) => {
    try {
        const { mentorId, studentId } = req.body;
        if (!mentorId || !studentId) {
            return res.status(400).json({ error: 'Mentor ID and Student ID are required' });
        }

        db.prepare('INSERT OR IGNORE INTO mentor_students (mentor_id, student_id) VALUES (?, ?)').run(mentorId, studentId);
        
        // Notify both student and mentor
        const mentor = db.prepare('SELECT full_name FROM users WHERE id = ?').get(mentorId);
        const student = db.prepare('SELECT full_name FROM users WHERE id = ?').get(studentId);

        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            studentId,
            'Mentor Assigned 🤝',
            `You have been assigned a mentor: ${mentor ? mentor.full_name : 'Unknown'}`
        );
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            mentorId,
            'New Student Assigned 🤝',
            `You have been assigned student: ${student ? student.full_name : 'Unknown'}`
        );

        res.json({ message: 'Mentor assigned successfully' });
    } catch (err) {
        console.error('Assign mentor error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/unassign-mentor - Unassign mentor from student
router.post('/unassign-mentor', (req, res) => {
    try {
        const { mentorId, studentId } = req.body;
        db.prepare('DELETE FROM mentor_students WHERE mentor_id = ? AND student_id = ?').run(mentorId, studentId);
        res.json({ message: 'Mentor unassigned successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
