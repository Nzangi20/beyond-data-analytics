const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = db.prepare(`
            SELECT u.*, r.name as role_name 
            FROM users u JOIN roles r ON u.role_id = r.id 
            WHERE u.username = ? AND u.is_active = 1
        `).get(username);

        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const validPassword = bcrypt.compareSync(password, user.password_hash);
        if (!validPassword) {
            // Log failed attempt
            db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
                user.id, 'login_failed', 'Invalid password', req.ip
            );
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign(
            { userId: user.id, role: user.role_name },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );

        // Log successful login
        db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
            user.id, 'login', 'Successful login', req.ip
        );

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                fullName: user.full_name,
                role: user.role_name,
                firstLogin: user.first_login === 1
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!newPassword || !confirmPassword) {
            return res.status(400).json({ error: 'New password and confirmation are required' });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

        // For first login, currentPassword check is optional (they have temp password)
        if (!user.first_login && currentPassword) {
            const valid = bcrypt.compareSync(currentPassword, user.password_hash);
            if (!valid) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
        }

        const hash = bcrypt.hashSync(newPassword, 12);
        db.prepare('UPDATE users SET password_hash = ?, first_login = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);

        // Log password change
        db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
            req.user.id, 'password_changed', user.first_login ? 'First login password change' : 'Password changed', req.ip
        );

        // Issue new token with updated state
        const token = jwt.sign(
            { userId: req.user.id, role: req.user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
        );

        res.json({ message: 'Password changed successfully', token });
    } catch (err) {
        console.error('Password change error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
    res.json({ user: req.user });
});

// POST /api/auth/logout
router.post('/logout', authenticateToken, (req, res) => {
    db.prepare('INSERT INTO activity_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(
        req.user.id, 'logout', 'User logged out', req.ip
    );
    res.json({ message: 'Logged out successfully' });
});

module.exports = router;
