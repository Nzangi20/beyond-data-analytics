const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken, requireRole, requirePasswordChanged } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');


router.use(authenticateToken, requirePasswordChanged, requireRole('student'));

// GET /api/exams/:examId/start - Start an exam
router.get('/:examId/start', (req, res) => {
    try {
        const exam = db.prepare(`
            SELECT e.*, m.title as module_title, m.module_number, m.tutorial_id, m.pass_mark,
                   t.name as tutorial_name
            FROM exams e
            JOIN modules m ON e.module_id = m.id
            JOIN tutorials t ON m.tutorial_id = t.id
            WHERE e.id = ? AND e.is_active = 1
        `).get(req.params.examId);

        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        // Check module is unlocked
        let progress = db.prepare('SELECT * FROM student_progress WHERE user_id = ? AND module_id = ?').get(req.user.id, exam.module_id);
        
        const isModule1 = exam.module_number === 1;
        if (isModule1 && (!progress || progress.status === 'locked')) {
            if (!progress) {
                db.prepare("INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'unlocked')").run(req.user.id, exam.module_id);
                progress = db.prepare('SELECT * FROM student_progress WHERE user_id = ? AND module_id = ?').get(req.user.id, exam.module_id);
            } else {
                db.prepare("UPDATE student_progress SET status = 'unlocked' WHERE user_id = ? AND module_id = ?").run(req.user.id, exam.module_id);
                progress.status = 'unlocked';
            }
        }

        if (!progress || progress.status === 'locked') {
            return res.status(403).json({ error: 'Module is locked' });
        }

        // Check for existing in-progress attempt
        let attempt = db.prepare("SELECT * FROM exam_attempts WHERE user_id = ? AND exam_id = ? AND status = 'in_progress'").get(req.user.id, exam.id);

        if (!attempt) {
            // Create new attempt
            const result = db.prepare('INSERT INTO exam_attempts (user_id, exam_id, total_marks) VALUES (?, ?, ?)').run(req.user.id, exam.id, exam.total_marks);
            attempt = db.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(result.lastInsertRowid);

            // Log exam start
            db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
                req.user.id, 'exam_started', `Started exam: ${exam.title}`, req.ip
            );
        }

        // Get questions with randomized order, and randomize answer order
        const questions = db.prepare('SELECT id, question_text, question_type, marks FROM questions WHERE exam_id = ? AND is_active = 1 ORDER BY RANDOM()').all(exam.id);

        questions.forEach(q => {
            q.answers = db.prepare('SELECT id, answer_text FROM answers WHERE question_id = ? ORDER BY RANDOM()').all(q.id);

            // Check if already answered in this attempt
            const response = db.prepare('SELECT * FROM exam_responses WHERE attempt_id = ? AND question_id = ?').get(attempt.id, q.id);
            q.answered = !!response;
            q.attemptsUsed = response ? response.attempts_used : 0;
            q.isCorrect = response ? response.is_correct === 1 : null;
        });

        res.json({
            attempt: { id: attempt.id, startedAt: attempt.started_at },
            exam: {
                id: exam.id,
                title: exam.title,
                timeLimit: exam.time_limit,
                totalMarks: exam.total_marks,
                passMark: exam.pass_mark,
                moduleName: exam.module_title,
                tutorialName: exam.tutorial_name
            },
            questions
        });
    } catch (err) {
        console.error('Start exam error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/exams/:examId/answer - Submit answer for a question
router.post('/:examId/answer', (req, res) => {
    try {
        const { attemptId, questionId, answerId } = req.body;
        if (!attemptId || !questionId || !answerId) {
            return res.status(400).json({ error: 'attemptId, questionId, and answerId are required' });
        }

        // Verify attempt belongs to user and is in progress
        const attempt = db.prepare("SELECT * FROM exam_attempts WHERE id = ? AND user_id = ? AND status = 'in_progress'").get(attemptId, req.user.id);
        if (!attempt) return res.status(403).json({ error: 'Invalid or completed exam attempt' });

        // Get question and correct answer
        const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
        const selectedAnswer = db.prepare('SELECT * FROM answers WHERE id = ? AND question_id = ?').get(answerId, questionId);
        if (!question || !selectedAnswer) return res.status(400).json({ error: 'Invalid question or answer' });

        const isCorrect = selectedAnswer.is_correct === 1;

        // Check existing response
        const existing = db.prepare('SELECT * FROM exam_responses WHERE attempt_id = ? AND question_id = ?').get(attemptId, questionId);

        if (existing) {
            // This is a retry (2nd attempt)
            if (existing.attempts_used >= 2) {
                return res.status(400).json({ error: 'Maximum attempts reached for this question', maxAttempts: true });
            }
            if (existing.is_correct === 1) {
                return res.status(400).json({ error: 'Question already answered correctly', alreadyCorrect: true });
            }

            // Update with 2nd attempt
            db.prepare('UPDATE exam_responses SET selected_answer_id = ?, is_correct = ?, attempts_used = 2, answered_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(answerId, isCorrect ? 1 : 0, existing.id);

            return res.json({
                isCorrect,
                attemptsUsed: 2,
                maxAttemptsReached: true,
                message: isCorrect ? 'Correct! Well done.' : 'Incorrect. Moving to next question.'
            });
        } else {
            // First attempt
            db.prepare('INSERT INTO exam_responses (attempt_id, question_id, selected_answer_id, is_correct, attempts_used) VALUES (?, ?, ?, ?, 1)')
                .run(attemptId, questionId, answerId, isCorrect ? 1 : 0);

            if (isCorrect) {
                return res.json({
                    isCorrect: true,
                    attemptsUsed: 1,
                    maxAttemptsReached: false,
                    message: 'Correct! Well done.'
                });
            } else {
                return res.json({
                    isCorrect: false,
                    attemptsUsed: 1,
                    maxAttemptsReached: false,
                    message: 'Incorrect. You have one more attempt.'
                });
            }
        }
    } catch (err) {
        console.error('Answer error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/exams/:examId/submit - Submit the entire exam
router.post('/:examId/submit', (req, res) => {
    try {
        const { attemptId, autoSubmitted } = req.body;
        if (!attemptId) return res.status(400).json({ error: 'attemptId is required' });

        const attempt = db.prepare('SELECT * FROM exam_attempts WHERE id = ? AND user_id = ?').get(attemptId, req.user.id);
        if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
        if (attempt.status !== 'in_progress') return res.status(400).json({ error: 'Exam already submitted' });

        // Calculate score
        const responses = db.prepare(`
            SELECT er.*, q.marks 
            FROM exam_responses er 
            JOIN questions q ON er.question_id = q.id 
            WHERE er.attempt_id = ?
        `).all(attemptId);

        let earnedMarks = 0;
        responses.forEach(r => {
            if (r.is_correct === 1) earnedMarks += r.marks;
        });

        const totalMarks = db.prepare('SELECT SUM(marks) as total FROM questions WHERE exam_id = ? AND is_active = 1').get(req.params.examId).total || 0;
        const percentage = totalMarks > 0 ? (earnedMarks / totalMarks) * 100 : 0;
        const status = autoSubmitted ? 'auto_submitted' : 'completed';

        db.prepare(`
            UPDATE exam_attempts 
            SET score = ?, total_marks = ?, percentage = ?, status = ?, finished_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(earnedMarks, totalMarks, Math.round(percentage * 10) / 10, status, attemptId);

        // Get the module & pass mark
        const exam = db.prepare('SELECT e.*, m.pass_mark, m.id as module_id, m.module_number, m.tutorial_id FROM exams e JOIN modules m ON e.module_id = m.id WHERE e.id = ?').get(req.params.examId);
        const passed = percentage >= exam.pass_mark;

        // Update student progress
        db.prepare(`
            UPDATE student_progress 
            SET status = ?, score = ?, attempts = attempts + 1, 
                completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND module_id = ?
        `).run(passed ? 'completed' : 'failed', Math.round(percentage * 10) / 10, passed ? 1 : 0, req.user.id, exam.module_id);

        const totalModulesCount = db.prepare('SELECT COUNT(*) as count FROM modules WHERE tutorial_id = ?').get(exam.tutorial_id).count;

        // If passed, unlock next module
        if (passed && exam.module_number < totalModulesCount) {
            const nextModule = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = ?').get(exam.tutorial_id, exam.module_number + 1);
            if (nextModule) {
                db.prepare("INSERT OR REPLACE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'unlocked')").run(req.user.id, nextModule.id);
            }
        }

        // If all modules completed, check for certificate
        if (passed) {
            const completedCount = db.prepare(`
                SELECT COUNT(*) as count FROM student_progress sp
                JOIN modules m ON sp.module_id = m.id
                WHERE sp.user_id = ? AND m.tutorial_id = ? AND sp.status = 'completed'
            `).get(req.user.id, exam.tutorial_id).count;

            if (completedCount >= totalModulesCount) {
                const enrollment = db.prepare('SELECT learning_mode FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, exam.tutorial_id);
                if (enrollment && enrollment.learning_mode === 'enrolled') {
                    // Auto-generate certificate for Enrolled mode
                    const certNumber = 'BDA-' + uuidv4().substring(0, 8).toUpperCase();
                    const qrData = `${process.env.APP_URL || 'http://localhost:3000'}/verify.html?cert=${certNumber}`;
                    db.prepare(`
                        INSERT OR IGNORE INTO certificates (user_id, tutorial_id, cert_number, qr_data)
                        VALUES (?, ?, ?, ?)
                    `).run(req.user.id, exam.tutorial_id, certNumber, qrData);

                    db.prepare("INSERT OR IGNORE INTO notifications (user_id, title, message) VALUES (?, 'Certificate Generated! 🎓', ?)")
                        .run(req.user.id, `Congratulations! You completed ${exam.tutorial_name || 'the course'} in Premium Enrolled mode. Your certificate ${certNumber} has been generated and is ready for download!`);
                } else {
                    // Notify self-learning student they qualify but must pay
                    db.prepare("INSERT OR IGNORE INTO notifications (user_id, title, message) VALUES (?, 'Eligible for Certification! 🎓', ?)")
                        .run(req.user.id, `Congratulations! You passed all modules for ${exam.tutorial_name || 'this course'} in Self-Learning mode. You are now eligible for certification! Pay the certificate fee to unlock download generation.`);
                }
            }
        }

        // Log exam completion
        db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
            req.user.id, autoSubmitted ? 'exam_auto_submitted' : 'exam_completed',
            `Exam: ${exam.title} | Score: ${Math.round(percentage)}% | ${passed ? 'PASSED' : 'FAILED'}`,
            req.ip
        );

        res.json({
            score: earnedMarks,
            totalMarks,
            percentage: Math.round(percentage * 10) / 10,
            passed,
            passMark: exam.pass_mark,
            status,
            message: passed ? 'Congratulations! You passed!' : 'You did not reach the pass mark. You can retake the exam.'
        });
    } catch (err) {
        console.error('Submit exam error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/exams/:examId/violation - Log exam violation
router.post('/:examId/violation', (req, res) => {
    try {
        const { attemptId, violationType, details } = req.body;
        if (!attemptId) return res.status(400).json({ error: 'attemptId required' });

        db.prepare('INSERT INTO violations (attempt_id, violation_type, details) VALUES (?, ?, ?)').run(attemptId, violationType, details);
        db.prepare('UPDATE exam_attempts SET violations_count = violations_count + 1 WHERE id = ?').run(attemptId);

        const attempt = db.prepare('SELECT violations_count FROM exam_attempts WHERE id = ?').get(attemptId);

        res.json({ violationsCount: attempt.violations_count });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/exams/external-submit
router.post('/external-submit', (req, res) => {
    try {
        const { tutorialSlug, moduleNumber, score, percentage, passed } = req.body;
        if (!tutorialSlug || !moduleNumber) {
            return res.status(400).json({ error: 'tutorialSlug and moduleNumber are required' });
        }

        const tutorial = db.prepare('SELECT id, name FROM tutorials WHERE slug = ?').get(tutorialSlug);
        if (!tutorial) return res.status(404).json({ error: 'Tutorial not found' });

        const moduleRecord = db.prepare('SELECT id, pass_mark, title FROM modules WHERE tutorial_id = ? AND module_number = ?').get(tutorial.id, moduleNumber);
        if (!moduleRecord) return res.status(404).json({ error: 'Module not found' });

        const exam = db.prepare('SELECT id, title, total_marks FROM exams WHERE module_id = ?').get(moduleRecord.id);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        // Enforce the pass mark backend-side
        const passMark = moduleRecord.pass_mark !== undefined && moduleRecord.pass_mark !== null ? moduleRecord.pass_mark : 70;
        const backendPassed = percentage >= passMark;

        // Insert completed exam attempt
        const result = db.prepare(`
            INSERT INTO exam_attempts (user_id, exam_id, score, total_marks, percentage, status, finished_at)
            VALUES (?, ?, ?, ?, ?, 'completed', CURRENT_TIMESTAMP)
        `).run(req.user.id, exam.id, score, exam.total_marks, percentage);
        
        // Update student progress
        db.prepare(`
            INSERT INTO student_progress (user_id, module_id, status, score, attempts, completed_at, updated_at)
            VALUES (?, ?, ?, ?, 1, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, module_id) DO UPDATE SET
                status = ?,
                score = CASE WHEN ? OR excluded.score > student_progress.score THEN excluded.score ELSE student_progress.score END,
                attempts = attempts + 1,
                completed_at = CASE WHEN ? AND completed_at IS NULL THEN CURRENT_TIMESTAMP ELSE completed_at END,
                updated_at = CURRENT_TIMESTAMP
        `).run(
            req.user.id, moduleRecord.id, backendPassed ? 'completed' : 'failed', percentage, backendPassed ? 1 : 0,
            backendPassed ? 'completed' : 'failed', backendPassed ? 1 : 0, backendPassed ? 1 : 0
        );

        const totalModulesCount = db.prepare('SELECT COUNT(*) as count FROM modules WHERE tutorial_id = ?').get(tutorial.id).count;

        // If passed and module number < totalModulesCount, unlock next module
        if (backendPassed && moduleNumber < totalModulesCount) {
            const nextModule = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = ?').get(tutorial.id, moduleNumber + 1);
            if (nextModule) {
                db.prepare(`
                    INSERT INTO student_progress (user_id, module_id, status)
                    VALUES (?, ?, 'unlocked')
                    ON CONFLICT(user_id, module_id) DO UPDATE SET status = 'unlocked' WHERE status = 'locked'
                `).run(req.user.id, nextModule.id);
            }
        }

        // Check certificate generation
        if (backendPassed) {
            const completedCount = db.prepare(`
                SELECT COUNT(*) as count FROM student_progress sp
                JOIN modules m ON sp.module_id = m.id
                WHERE sp.user_id = ? AND m.tutorial_id = ? AND sp.status = 'completed'
            `).get(req.user.id, tutorial.id).count;

            if (completedCount >= totalModulesCount) {
                const enrollment = db.prepare('SELECT learning_mode FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, tutorial.id);
                if (enrollment && enrollment.learning_mode === 'enrolled') {
                    const certNumber = 'BDA-' + uuidv4().substring(0, 8).toUpperCase();
                    const qrData = `${process.env.APP_URL || 'http://localhost:3000'}/verify.html?cert=${certNumber}`;
                    db.prepare(`
                        INSERT OR IGNORE INTO certificates (user_id, tutorial_id, cert_number, qr_data)
                        VALUES (?, ?, ?, ?)
                    `).run(req.user.id, tutorial.id, certNumber, qrData);

                    db.prepare("INSERT OR IGNORE INTO notifications (user_id, title, message) VALUES (?, 'Certificate Generated! 🎓', ?)")
                        .run(req.user.id, `Congratulations! You completed ${tutorial.name} in Premium Enrolled mode. Your certificate ${certNumber} has been generated and is ready for download!`);
                } else {
                    db.prepare("INSERT OR IGNORE INTO notifications (user_id, title, message) VALUES (?, 'Eligible for Certification! 🎓', ?)")
                        .run(req.user.id, `Congratulations! You passed all modules for ${tutorial.name} in Self-Learning mode. You are now eligible for certification! Pay the certificate fee to unlock download generation.`);
                }
            }
        }

        // Log activity
        db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
            req.user.id, 'exam_completed',
            `Exam: ${exam.title} (HTML) | Score: ${percentage}% | ${backendPassed ? 'PASSED' : 'FAILED'}`,
            req.ip
        );

        res.json({ success: true, passed: backendPassed, percentage });
    } catch (err) {
        console.error('External submit exam error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
