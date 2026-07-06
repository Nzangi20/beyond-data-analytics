const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../config/database');
const { authenticateToken, requireRole, requirePasswordChanged } = require('../middleware/auth');

router.use(authenticateToken, requirePasswordChanged, requireRole('instructor'));

// File upload configuration
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

// Helper to check if instructor is assigned to a specific tutorial
function checkCourseAccess(instructorId, tutorialId) {
    const assigned = db.prepare('SELECT id FROM tutorial_instructors WHERE instructor_id = ? AND tutorial_id = ?').get(instructorId, tutorialId);
    return !!assigned;
}

// Helper to check if instructor is assigned to a specific module
function checkModuleAccess(instructorId, moduleId) {
    const module = db.prepare('SELECT tutorial_id FROM modules WHERE id = ?').get(moduleId);
    if (!module) return false;
    return checkCourseAccess(instructorId, module.tutorial_id);
}

// Helper to check if instructor is assigned to a specific exam
function checkExamAccess(instructorId, examId) {
    const exam = db.prepare('SELECT module_id FROM exams WHERE id = ?').get(examId);
    if (!exam) return false;
    return checkModuleAccess(instructorId, exam.module_id);
}

// Helper to check if instructor is assigned to a specific lesson
function checkLessonAccess(instructorId, lessonId) {
    const lesson = db.prepare('SELECT module_id FROM lessons WHERE id = ?').get(lessonId);
    if (!lesson) return false;
    return checkModuleAccess(instructorId, lesson.module_id);
}

// ==================== COURSE MANAGEMENT ====================

// GET /api/instructor/courses - Get courses assigned to this instructor
router.get('/courses', (req, res) => {
    try {
        const courses = db.prepare(`
            SELECT t.* 
            FROM tutorials t
            JOIN tutorial_instructors ti ON t.id = ti.tutorial_id
            WHERE ti.instructor_id = ? AND t.is_active = 1
        `).all(req.user.id);
        res.json({ courses });
    } catch (err) {
        console.error('Get instructor courses error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/instructor/courses/:id/modules - Get modules for a course
router.get('/courses/:id/modules', (req, res) => {
    try {
        if (!checkCourseAccess(req.user.id, req.params.id)) {
            return res.status(403).json({ error: 'Unauthorized course access' });
        }
        const modules = db.prepare('SELECT * FROM modules WHERE tutorial_id = ? ORDER BY module_number').all(req.params.id);
        res.json({ modules });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/instructor/modules/:id/lessons - Get lessons for a module
router.get('/modules/:id/lessons', (req, res) => {
    try {
        if (!checkModuleAccess(req.user.id, req.params.id)) {
            return res.status(403).json({ error: 'Unauthorized module access' });
        }
        const lessons = db.prepare('SELECT * FROM lessons WHERE module_id = ? ORDER BY order_num').all(req.params.id);
        res.json({ lessons });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/instructor/lessons - Add a new lesson (notes/videos/materials)
router.post('/lessons', upload.single('file'), (req, res) => {
    try {
        const { moduleId, title, contentType, contentText } = req.body;
        if (!moduleId || !title || !contentType) {
            return res.status(400).json({ error: 'Module ID, title, and content type are required' });
        }

        if (!checkModuleAccess(req.user.id, moduleId)) {
            return res.status(403).json({ error: 'Unauthorized module access' });
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

// DELETE /api/instructor/lessons/:id - Delete a lesson
router.delete('/lessons/:id', (req, res) => {
    try {
        if (!checkLessonAccess(req.user.id, req.params.id)) {
            return res.status(403).json({ error: 'Unauthorized lesson access' });
        }

        const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(req.params.id);
        if (lesson && lesson.file_path) {
            const fullPath = path.join(__dirname, '..', lesson.file_path);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        db.prepare('DELETE FROM lessons WHERE id = ?').run(req.params.id);
        res.json({ message: 'Lesson deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== EXAM & QUIZ QUESTION MANAGEMENT ====================

// GET /api/instructor/exams - Get exams for instructor's courses
router.get('/exams', (req, res) => {
    try {
        const exams = db.prepare(`
            SELECT e.*, m.title as module_title, m.module_number, t.name as tutorial_name
            FROM exams e
            JOIN modules m ON e.module_id = m.id
            JOIN tutorials t ON m.tutorial_id = t.id
            JOIN tutorial_instructors ti ON t.id = ti.tutorial_id
            WHERE ti.instructor_id = ?
            ORDER BY t.id, m.module_number
        `).all(req.user.id);
        res.json({ exams });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/instructor/exams - Create an exam
router.post('/exams', (req, res) => {
    try {
        const { moduleId, title, description, timeLimit, totalMarks } = req.body;
        if (!moduleId || !title) {
            return res.status(400).json({ error: 'Module ID and title are required' });
        }

        if (!checkModuleAccess(req.user.id, moduleId)) {
            return res.status(403).json({ error: 'Unauthorized module access' });
        }

        const result = db.prepare(`
            INSERT INTO exams (module_id, title, description, time_limit, total_marks)
            VALUES (?, ?, ?, ?, ?)
        `).run(moduleId, title, description || null, timeLimit || 60, totalMarks || 100);

        res.status(201).json({ message: 'Exam created successfully', examId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create exam error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/instructor/exams/:id - Update an exam
router.put('/exams/:id', (req, res) => {
    try {
        if (!checkExamAccess(req.user.id, req.params.id)) {
            return res.status(403).json({ error: 'Unauthorized exam access' });
        }

        const { title, description, timeLimit, totalMarks, isActive } = req.body;
        db.prepare(`
            UPDATE exams SET title = ?, description = ?, time_limit = ?, total_marks = ?, is_active = ?
            WHERE id = ?
        `).run(title, description, timeLimit, totalMarks, isActive !== undefined ? isActive : 1, req.params.id);

        res.json({ message: 'Exam updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/instructor/exams/:id - Delete an exam
router.delete('/exams/:id', (req, res) => {
    try {
        if (!checkExamAccess(req.user.id, req.params.id)) {
            return res.status(403).json({ error: 'Unauthorized exam access' });
        }
        db.prepare('DELETE FROM exams WHERE id = ?').run(req.params.id);
        res.json({ message: 'Exam deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/instructor/exams/:examId/questions - Get questions for an exam
router.get('/exams/:examId/questions', (req, res) => {
    try {
        if (!checkExamAccess(req.user.id, req.params.examId)) {
            return res.status(403).json({ error: 'Unauthorized exam access' });
        }

        const questions = db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY order_num').all(req.params.examId);
        questions.forEach(q => {
            q.answers = db.prepare('SELECT * FROM answers WHERE question_id = ? ORDER BY order_num').all(q.id);
        });

        res.json({ questions });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/instructor/questions - Add question to an exam
router.post('/questions', (req, res) => {
    try {
        const { examId, questionText, questionType, marks, explanation, answers } = req.body;
        if (!examId || !questionText || !questionType) {
            return res.status(400).json({ error: 'Exam ID, question text, and type are required' });
        }
        if (!checkExamAccess(req.user.id, examId)) {
            return res.status(403).json({ error: 'Unauthorized exam access' });
        }
        if (!answers || answers.length < 2) {
            return res.status(400).json({ error: 'At least 2 options are required' });
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

        res.status(201).json({ message: 'Question created successfully', questionId: qId });
    } catch (err) {
        console.error('Create question error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/instructor/questions/:id - Update question details
router.put('/questions/:id', (req, res) => {
    try {
        const question = db.prepare('SELECT exam_id FROM questions WHERE id = ?').get(req.params.id);
        if (!question || !checkExamAccess(req.user.id, question.exam_id)) {
            return res.status(403).json({ error: 'Unauthorized question access' });
        }

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

        res.json({ message: 'Question updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/instructor/questions/:id - Delete a question
router.delete('/questions/:id', (req, res) => {
    try {
        const question = db.prepare('SELECT exam_id FROM questions WHERE id = ?').get(req.params.id);
        if (!question || !checkExamAccess(req.user.id, question.exam_id)) {
            return res.status(403).json({ error: 'Unauthorized question access' });
        }

        db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
        res.json({ message: 'Question deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== WORKSHOPS MANAGEMENT ====================

// GET /api/instructor/workshops - Get instructor's workshops
router.get('/workshops', (req, res) => {
    try {
        const workshops = db.prepare(`
            SELECT w.*, t.name as tutorial_name
            FROM workshops w
            JOIN tutorials t ON w.tutorial_id = t.id
            WHERE w.instructor_id = ?
            ORDER BY w.schedule_date DESC
        `).all(req.user.id);
        res.json({ workshops });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/instructor/workshops - Schedule a workshop
router.post('/workshops', (req, res) => {
    try {
        const { title, description, tutorialId, scheduleDate, meetingLink } = req.body;
        if (!title || !tutorialId || !scheduleDate) {
            return res.status(400).json({ error: 'Title, tutorial, and schedule date are required' });
        }

        if (!checkCourseAccess(req.user.id, tutorialId)) {
            return res.status(403).json({ error: 'Unauthorized course access' });
        }

        db.prepare(`
            INSERT INTO workshops (title, description, tutorial_id, instructor_id, schedule_date, meeting_link)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(title, description || null, tutorialId, req.user.id, scheduleDate, meetingLink || null);

        // Notify students enrolled in this tutorial
        const students = db.prepare('SELECT user_id FROM user_tutorials WHERE tutorial_id = ?').all(tutorialId);
        students.forEach(s => {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                s.user_id,
                'New Workshop Scheduled 📅',
                `A new workshop "${title}" has been scheduled for your course. Check the Workshops tab to join.`
            );
        });

        res.status(201).json({ message: 'Workshop scheduled successfully' });
    } catch (err) {
        console.error('Schedule workshop error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/instructor/workshops/:id - Cancel a workshop
router.delete('/workshops/:id', (req, res) => {
    try {
        const workshop = db.prepare('SELECT * FROM workshops WHERE id = ?').get(req.params.id);
        if (!workshop || workshop.instructor_id !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('DELETE FROM workshops WHERE id = ?').run(req.params.id);
        res.json({ message: 'Workshop cancelled' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== STUDENT ANALYTICS ====================

// GET /api/instructor/analytics - View statistics of students in instructor's courses
router.get('/analytics', (req, res) => {
    try {
        // Find tutorials assigned to instructor
        const courseIds = db.prepare('SELECT tutorial_id FROM tutorial_instructors WHERE instructor_id = ?').all(req.user.id).map(c => c.tutorial_id);
        if (courseIds.length === 0) {
            return res.json({ students: [] });
        }

        const placeholders = courseIds.map(() => '?').join(',');
        const students = db.prepare(`
            SELECT DISTINCT u.id, u.full_name, u.username, u.email, t.name as tutorial_name, ut.enrolled_at
            FROM user_tutorials ut
            JOIN users u ON ut.user_id = u.id
            JOIN tutorials t ON ut.tutorial_id = t.id
            WHERE ut.tutorial_id IN (${placeholders}) AND u.is_active = 1
            ORDER BY ut.enrolled_at DESC
        `).all(...courseIds);

        students.forEach(s => {
            // Calculate completed modules and average scores
            const prog = db.prepare(`
                SELECT 
                    COUNT(m.id) as total_modules,
                    SUM(CASE WHEN sp.status = 'completed' THEN 1 ELSE 0 END) as completed_modules,
                    ROUND(AVG(CASE WHEN sp.score IS NOT NULL THEN sp.score ELSE 0 END), 1) as avg_score
                FROM user_tutorials ut
                JOIN tutorials t ON ut.tutorial_id = t.id
                JOIN modules m ON m.tutorial_id = t.id
                LEFT JOIN student_progress sp ON sp.module_id = m.id AND sp.user_id = ?
                WHERE ut.user_id = ? AND t.name = ?
                GROUP BY t.id
            `).get(s.id, s.id, s.tutorial_name);

            s.completed_modules = prog ? prog.completed_modules : 0;
            s.total_modules = prog ? prog.total_modules : 0;
            s.avg_score = prog ? prog.avg_score : 0;
        });

        res.json({ students });
    } catch (err) {
        console.error('Get instructor analytics error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/instructor/assignments - Get assignments for instructor's courses
router.get('/assignments', (req, res) => {
    try {
        const courseIds = db.prepare('SELECT tutorial_id FROM tutorial_instructors WHERE instructor_id = ?').all(req.user.id).map(c => c.tutorial_id);
        if (courseIds.length === 0) return res.json({ assignments: [] });

        const placeholders = courseIds.map(() => '?').join(',');
        const assignments = db.prepare(`
            SELECT a.*, t.name as tutorial_name
            FROM assignments a
            JOIN tutorials t ON a.tutorial_id = t.id
            WHERE a.tutorial_id IN (${placeholders})
            ORDER BY a.created_at DESC
        `).all(...courseIds);

        res.json({ assignments });
    } catch (err) {
        console.error('Instructor get assignments error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/instructor/assignments - Create a new assignment
router.post('/assignments', upload.single('file'), (req, res) => {
    try {
        const { tutorialId, title, description, dueDate } = req.body;
        if (!tutorialId || !title) {
            return res.status(400).json({ error: 'Tutorial ID and title are required' });
        }

        if (!checkCourseAccess(req.user.id, tutorialId)) {
            return res.status(403).json({ error: 'Unauthorized course access' });
        }

        let filePath = null;
        if (req.file) {
            filePath = '/uploads/materials/' + req.file.filename;
        }

        const result = db.prepare(`
            INSERT INTO assignments (tutorial_id, title, description, file_path, due_date)
            VALUES (?, ?, ?, ?, ?)
        `).run(tutorialId, title, description || null, filePath, dueDate || null);

        // Notify enrolled students (only premium ones)
        const students = db.prepare("SELECT user_id FROM user_tutorials WHERE tutorial_id = ? AND learning_mode = 'enrolled'").all(tutorialId);
        students.forEach(s => {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                s.user_id,
                'New Assignment Published 📝',
                `A new assignment "${title}" has been published. Please complete it by the due date.`
            );
        });

        res.status(201).json({ message: 'Assignment created successfully', assignmentId: result.lastInsertRowid });
    } catch (err) {
        console.error('Create assignment error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/instructor/assignments/submissions - View student submissions
router.get('/assignments/submissions', (req, res) => {
    try {
        const courseIds = db.prepare('SELECT tutorial_id FROM tutorial_instructors WHERE instructor_id = ?').all(req.user.id).map(c => c.tutorial_id);
        if (courseIds.length === 0) return res.json({ submissions: [] });

        const placeholders = courseIds.map(() => '?').join(',');
        const submissions = db.prepare(`
            SELECT sa.*, a.title as assignment_title, t.name as tutorial_name, u.full_name as student_name, u.username as student_username
            FROM student_assignments sa
            JOIN assignments a ON sa.assignment_id = a.id
            JOIN tutorials t ON a.tutorial_id = t.id
            JOIN users u ON sa.user_id = u.id
            WHERE a.tutorial_id IN (${placeholders})
            ORDER BY sa.submitted_at DESC
        `).all(...courseIds);

        res.json({ submissions });
    } catch (err) {
        console.error('Get submissions error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/instructor/assignments/grade - Grade a submission
router.post('/assignments/grade', (req, res) => {
    try {
        const { submissionId, grade, feedback } = req.body;
        if (!submissionId || !grade) {
            return res.status(400).json({ error: 'Submission ID and grade are required' });
        }

        const submission = db.prepare(`
            SELECT sa.*, a.tutorial_id, a.title as assignment_title 
            FROM student_assignments sa
            JOIN assignments a ON sa.assignment_id = a.id
            WHERE sa.id = ?
        `).get(submissionId);

        if (!submission) return res.status(404).json({ error: 'Submission not found' });

        if (!checkCourseAccess(req.user.id, submission.tutorial_id)) {
            return res.status(403).json({ error: 'Unauthorized course access' });
        }

        db.prepare(`
            UPDATE student_assignments 
            SET grade = ?, feedback = ?, graded_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `).run(grade, feedback || null, submissionId);

        // Notify student
        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            submission.user_id,
            'Assignment Graded 📝',
            `Your submission for "${submission.assignment_title}" has been graded. Grade: ${grade}.`
        );

        res.json({ message: 'Submission graded successfully' });
    } catch (err) {
        console.error('Grade submission error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
