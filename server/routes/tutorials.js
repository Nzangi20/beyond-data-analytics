const express = require('express');
const router = express.Router();
const { db } = require('../config/database');

// Public route - list all active tutorials
router.get('/', (req, res) => {
    try {
        const tutorials = db.prepare('SELECT * FROM tutorials WHERE is_active = 1 ORDER BY id').all();
        tutorials.forEach(t => {
            t.moduleCount = db.prepare('SELECT COUNT(*) as count FROM modules WHERE tutorial_id = ?').get(t.id).count;
        });
        res.json({ tutorials });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route - get tutorial info
router.get('/:slug', (req, res) => {
    try {
        const tutorial = db.prepare('SELECT * FROM tutorials WHERE slug = ? AND is_active = 1').get(req.params.slug);
        if (!tutorial) return res.status(404).json({ error: 'Tutorial not found' });

        const modules = db.prepare('SELECT id, module_number, title, description FROM modules WHERE tutorial_id = ? AND is_active = 1 ORDER BY module_number').all(tutorial.id);
        res.json({ tutorial, modules });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route - get module content (lessons, videos, exercises, materials) without account/enrollment check
router.get('/modules/:id/content', (req, res) => {
    try {
        const module = db.prepare('SELECT m.*, t.name as tutorial_name, t.slug as tutorial_slug FROM modules m JOIN tutorials t ON m.tutorial_id = t.id WHERE m.id = ? AND m.is_active = 1').get(req.params.id);
        if (!module) return res.status(404).json({ error: 'Module not found' });

        const lessons = db.prepare('SELECT * FROM lessons WHERE module_id = ? AND is_active = 1 ORDER BY order_num').all(module.id);
        
        // Group lessons by type
        const notes = lessons.filter(l => l.content_type === 'notes');
        const videos = lessons.filter(l => l.content_type === 'video');
        const exercises = lessons.filter(l => l.content_type === 'exercise');
        const materials = lessons.filter(l => l.content_type === 'material');

        res.json({
            module,
            content: { notes, videos, exercises, materials }
        });
    } catch (err) {
        console.error('Public module content error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route - get module exam (questions and answers without is_correct)
router.get('/modules/:id/exam', (req, res) => {
    try {
        const moduleId = req.params.id;
        const exam = db.prepare(`
            SELECT e.*, m.pass_mark 
            FROM exams e 
            JOIN modules m ON e.module_id = m.id 
            WHERE e.module_id = ? AND e.is_active = 1
        `).get(moduleId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const questions = db.prepare('SELECT id, question_text, question_type, marks FROM questions WHERE exam_id = ? AND is_active = 1 ORDER BY order_num').all(exam.id);
        
        questions.forEach(q => {
            q.answers = db.prepare('SELECT id, answer_text FROM answers WHERE question_id = ? ORDER BY order_num').all(q.id);
        });

        res.json({ exam, questions });
    } catch (err) {
        console.error('Public exam fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route - submit module exam and grade it securely on the server
router.post('/modules/:id/exam/submit', (req, res) => {
    try {
        const moduleId = req.params.id;
        const { answers } = req.body; // Map of questionId -> answerId
        if (!answers) return res.status(400).json({ error: 'Answers are required' });

        const exam = db.prepare(`
            SELECT e.*, m.pass_mark 
            FROM exams e 
            JOIN modules m ON e.module_id = m.id 
            WHERE e.module_id = ? AND e.is_active = 1
        `).get(moduleId);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });

        const questions = db.prepare('SELECT id, marks FROM questions WHERE exam_id = ? AND is_active = 1').all(exam.id);

        let earnedMarks = 0;
        let totalMarks = 0;

        questions.forEach(q => {
            totalMarks += q.marks;
            const submittedAnswerId = answers[q.id];
            if (submittedAnswerId) {
                const correctAnswer = db.prepare('SELECT is_correct FROM answers WHERE id = ? AND question_id = ?').get(submittedAnswerId, q.id);
                if (correctAnswer && correctAnswer.is_correct === 1) {
                    earnedMarks += q.marks;
                }
            }
        });

        const percentage = totalMarks > 0 ? (earnedMarks / totalMarks) * 100 : 0;
        const passMark = exam.pass_mark !== undefined && exam.pass_mark !== null ? exam.pass_mark : 70;
        const passed = percentage >= passMark;

        res.json({
            score: earnedMarks,
            totalMarks,
            percentage: Math.round(percentage * 10) / 10,
            passed,
            passMark: passMark,
            message: passed ? 'Congratulations! You passed the module exam.' : 'You did not reach the pass mark. You can study and try again.'
        });
    } catch (err) {
        console.error('Public exam submit error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
