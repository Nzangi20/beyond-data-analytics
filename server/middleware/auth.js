const jwt = require('jsonwebtoken');
const { db } = require('../config/database');

// Verify JWT token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = db.prepare('SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? AND u.is_active = 1').get(decoded.userId);
        
        if (!user) {
            return res.status(401).json({ error: 'User not found or deactivated' });
        }

        req.user = {
            id: user.id,
            username: user.username,
            email: user.email,
            fullName: user.full_name,
            role: user.role_name,
            roleId: user.role_id,
            firstLogin: user.first_login === 1
        };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// Role-based access control
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

// Check if first login password change is completed
function requirePasswordChanged(req, res, next) {
    if (req.user && req.user.firstLogin) {
        return res.status(403).json({ 
            error: 'Password change required',
            requirePasswordChange: true
        });
    }
    next();
}

module.exports = { authenticateToken, requireRole, requirePasswordChanged };
