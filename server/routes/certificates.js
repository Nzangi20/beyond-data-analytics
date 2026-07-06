const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const QRCode = require('qrcode');

// Public verification endpoint
router.get('/verify/:certNumber', (req, res) => {
    try {
        const cert = db.prepare(`
            SELECT c.*, u.full_name, t.name as tutorial_name
            FROM certificates c
            JOIN users u ON c.user_id = u.id
            JOIN tutorials t ON c.tutorial_id = t.id
            WHERE c.cert_number = ?
        `).get(req.params.certNumber);

        if (!cert) return res.status(404).json({ error: 'Certificate not found', valid: false });

        res.json({
            valid: true,
            certificate: {
                certNumber: cert.cert_number,
                studentName: cert.full_name,
                courseName: cert.tutorial_name,
                issuedAt: cert.issued_at
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get student certificates and eligibility states
router.get('/my', authenticateToken, (req, res) => {
    try {
        const enrollments = db.prepare(`
            SELECT ut.tutorial_id, t.name as tutorial_name, t.certificate_fee,
                   (SELECT COUNT(*) FROM modules WHERE tutorial_id = ut.tutorial_id) as total_modules,
                   (SELECT COUNT(*) FROM student_progress sp 
                    JOIN modules m ON sp.module_id = m.id 
                    WHERE sp.user_id = ut.user_id AND m.tutorial_id = ut.tutorial_id AND sp.status = 'completed') as completed_modules,
                   p.transaction_ref, p.created_at as paid_at,
                   c.cert_number, c.issued_at, u.full_name
            FROM user_tutorials ut
            JOIN tutorials t ON ut.tutorial_id = t.id
            JOIN users u ON ut.user_id = u.id
            LEFT JOIN payments p ON p.user_id = ut.user_id AND p.target_type = 'certificate' AND p.target_id = ut.tutorial_id AND p.status = 'completed'
            LEFT JOIN certificates c ON c.user_id = ut.user_id AND c.tutorial_id = ut.tutorial_id
            WHERE ut.user_id = ?
        `).all(req.user.id);

        res.json({ enrollments });
    } catch (err) {
        console.error('My certs error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Generate QR code image
router.get('/qr/:certNumber', async (req, res) => {
    try {
        const cert = db.prepare('SELECT * FROM certificates WHERE cert_number = ?').get(req.params.certNumber);
        if (!cert) return res.status(404).json({ error: 'Certificate not found' });

        const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify.html?cert=${cert.cert_number}`;
        const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 200, margin: 1 });
        res.json({ qrCode: qrDataUrl, verifyUrl });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
