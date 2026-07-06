const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// POST /api/payments/checkout - Simulate payment for certificates or consultancy
router.post('/checkout', authenticateToken, (req, res) => {
    try {
        const { targetType, targetId, amount, paymentMethod } = req.body;
        if (!targetType || !targetId || !amount || !paymentMethod) {
            return res.status(400).json({ error: 'Missing payment details' });
        }

        const transactionRef = 'TXN-' + uuidv4().substring(0, 8).toUpperCase();

        if (targetType === 'certificate') {
            const tutorialId = parseInt(targetId);
            
            // 1. Verify tutorial exists
            const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tutorialId);
            if (!tutorial) return res.status(404).json({ error: 'Tutorial not found' });

            // 2. Check if student finished all 4 modules with a pass (completed status)
            const progress = db.prepare(`
                SELECT COUNT(*) as count FROM student_progress sp
                JOIN modules m ON sp.module_id = m.id
                WHERE sp.user_id = ? AND m.tutorial_id = ? AND sp.status = 'completed'
            `).get(req.user.id, tutorialId).count;

            if (progress < 4) {
                return res.status(400).json({ error: 'You are not eligible for certification yet. Complete all 4 modules first.' });
            }

            // 3. Register payment
            db.prepare(`
                INSERT INTO payments (user_id, target_type, target_id, amount, payment_method, transaction_ref, status)
                VALUES (?, ?, ?, ?, ?, ?, 'completed')
            `).run(req.user.id, 'certificate', tutorialId, amount, paymentMethod, transactionRef);

            // 4. Generate Certificate record now that it is paid
            const certNumber = 'BDA-' + uuidv4().substring(0, 8).toUpperCase();
            const qrData = `${process.env.APP_URL || 'http://localhost:3000'}/verify.html?cert=${certNumber}`;
            
            db.prepare(`
                INSERT OR IGNORE INTO certificates (user_id, tutorial_id, cert_number, qr_data)
                VALUES (?, ?, ?, ?)
            `).run(req.user.id, tutorialId, certNumber, qrData);

            // Notify user
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                req.user.id,
                'Certificate Unlocked! 🎉',
                `Your payment of KES ${amount} via ${paymentMethod} was received. Certificate ${certNumber} is now available!`
            );

            // Log activity
            db.prepare('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'payment_completed', `Paid KES ${amount} for ${tutorial.name} Certificate (Ref: ${transactionRef})`
            );

            return res.json({ success: true, transactionRef, certNumber });

        } else if (targetType === 'consultancy') {
            const requestId = parseInt(targetId);
            const request = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(requestId);
            if (!request) return res.status(404).json({ error: 'Consultancy request not found' });

            // Register payment
            db.prepare(`
                INSERT INTO payments (user_id, target_type, target_id, amount, payment_method, transaction_ref, status)
                VALUES (?, ?, ?, ?, ?, ?, 'completed')
            `).run(req.user.id, 'consultancy', requestId, amount, paymentMethod, transactionRef);

            // Update request invoice status
            db.prepare("UPDATE consultancy_requests SET payment_status = 'paid' WHERE id = ?").run(requestId);

            // Notify client & consultant
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                req.user.id,
                'Invoice Paid',
                `Payment of KES ${amount} for project "${request.company || 'Consultancy'}" has been approved.`
            );

            if (request.assigned_to) {
                db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                    request.assigned_to,
                    'Client Invoice Paid',
                    `Client paid KES ${amount} for assigned project: "${request.company || 'Consultancy'}"`
                );
            }

            // Log activity
            db.prepare('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'payment_completed', `Paid invoice KES ${amount} for consultancy request #${requestId}`
            );

            return res.json({ success: true, transactionRef });
        } else if (targetType === 'enrollment') {
            const tutorialId = parseInt(targetId);
            const tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tutorialId);
            if (!tutorial) return res.status(404).json({ error: 'Tutorial not found' });

            // 1. Register payment in db
            db.prepare(`
                INSERT INTO payments (user_id, target_type, target_id, amount, payment_method, transaction_ref, status)
                VALUES (?, ?, ?, ?, ?, ?, 'completed')
            `).run(req.user.id, 'enrollment', tutorialId, amount, paymentMethod, transactionRef);

            // 2. Set learning mode as enrolled
            const existing = db.prepare('SELECT * FROM user_tutorials WHERE user_id = ? AND tutorial_id = ?').get(req.user.id, tutorialId);
            if (existing) {
                db.prepare("UPDATE user_tutorials SET learning_mode = 'enrolled', payment_status = 'paid' WHERE user_id = ? AND tutorial_id = ?").run(req.user.id, tutorialId);
            } else {
                db.prepare("INSERT INTO user_tutorials (user_id, tutorial_id, learning_mode, payment_status) VALUES (?, ?, 'enrolled', 'paid')").run(req.user.id, tutorialId);
            }

            // 3. Unlock module 1, ensure others exist
            const module1 = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number = 1').get(tutorialId);
            if (module1) {
                db.prepare("INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'unlocked')").run(req.user.id, module1.id);
            }
            const otherModules = db.prepare('SELECT id FROM modules WHERE tutorial_id = ? AND module_number > 1').all(tutorialId);
            otherModules.forEach(m => {
                db.prepare("INSERT OR IGNORE INTO student_progress (user_id, module_id, status) VALUES (?, ?, 'locked')").run(req.user.id, m.id);
            });

            // 4. Check if student already passed all 4 modules (completed in self-learning first)
            const completedCount = db.prepare(`
                SELECT COUNT(*) as count FROM student_progress sp
                JOIN modules m ON sp.module_id = m.id
                WHERE sp.user_id = ? AND m.tutorial_id = ? AND sp.status = 'completed'
            `).get(req.user.id, tutorialId).count;

            let certGenerated = false;
            let certNumber = null;
            if (completedCount >= 4) {
                certNumber = 'BDA-' + uuidv4().substring(0, 8).toUpperCase();
                const qrData = `${process.env.APP_URL || 'http://localhost:3000'}/verify.html?cert=${certNumber}`;
                db.prepare(`
                    INSERT OR IGNORE INTO certificates (user_id, tutorial_id, cert_number, qr_data)
                    VALUES (?, ?, ?, ?)
                `).run(req.user.id, tutorialId, certNumber, qrData);
                certGenerated = true;
            }

            // 5. Notify user
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                req.user.id,
                'Premium Program Enrolled! 🎓',
                `Welcome to Premium Enrolled Mode for ${tutorial.name}! Your payment of KES ${amount} via ${paymentMethod} was approved.`
            );

            // Log activity
            db.prepare('INSERT INTO activity_logs (user_id, action, details) VALUES (?, ?, ?)').run(
                req.user.id, 'payment_completed', `Paid KES ${amount} for Premium Enrollment in ${tutorial.name} (Ref: ${transactionRef})`
            );

            return res.json({ success: true, transactionRef, certGenerated, certNumber });
        }

        res.status(400).json({ error: 'Invalid target type' });
    } catch (err) {
        console.error('Payment checkout error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/payments/my - Student view their own transaction records
router.get('/my', authenticateToken, (req, res) => {
    try {
        const list = db.prepare(`
            SELECT p.*,
                   CASE 
                     WHEN p.target_type = 'certificate' THEN t.name 
                     WHEN p.target_type = 'enrollment' THEN t.name
                     ELSE 'Other'
                   END as target_name
            FROM payments p
            LEFT JOIN tutorials t ON (p.target_type = 'certificate' OR p.target_type = 'enrollment') AND p.target_id = t.id
            WHERE p.user_id = ?
            ORDER BY p.created_at DESC
        `).all(req.user.id);
        res.json({ payments: list });
    } catch (err) {
        console.error('Get student payments error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/payments/list - Admin view transaction records
router.get('/list', authenticateToken, requireRole('admin'), (req, res) => {
    try {
        const list = db.prepare(`
            SELECT p.*, u.full_name as user_full_name, u.username as user_name,
                   CASE 
                     WHEN p.target_type = 'certificate' THEN t.name 
                     WHEN p.target_type = 'enrollment' THEN t.name
                     ELSE cr.company 
                   END as target_name
            FROM payments p
            JOIN users u ON p.user_id = u.id
            LEFT JOIN tutorials t ON (p.target_type = 'certificate' OR p.target_type = 'enrollment') AND p.target_id = t.id
            LEFT JOIN consultancy_requests cr ON p.target_type = 'consultancy' AND p.target_id = cr.id
            ORDER BY p.created_at DESC
        `).all();
        res.json({ list });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/payments/:id/refund - Admin refund payment
router.post('/:id/refund', authenticateToken, requireRole('admin'), (req, res) => {
    try {
        const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
        if (!payment) return res.status(404).json({ error: 'Payment record not found' });

        db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(req.params.id);

        if (payment.target_type === 'certificate') {
            db.prepare('DELETE FROM certificates WHERE user_id = ? AND tutorial_id = ?').run(payment.user_id, payment.target_id);
        } else if (payment.target_type === 'consultancy') {
            db.prepare("UPDATE consultancy_requests SET payment_status = 'unpaid' WHERE id = ?").run(payment.target_id);
        } else if (payment.target_type === 'enrollment') {
            db.prepare("UPDATE user_tutorials SET learning_mode = 'self', payment_status = 'unpaid' WHERE user_id = ? AND tutorial_id = ?").run(payment.user_id, payment.target_id);
        }

        db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
            payment.user_id,
            'Payment Refunded',
            `Your payment of KES ${payment.amount} (Ref: ${payment.transaction_ref}) was marked as refunded by the administrator.`
        );

        res.json({ message: 'Payment refunded successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
