const express = require('express');
const router = express.Router();
const { db } = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads', 'materials');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/consultancy/request - Submit a request (Public or logged-in Clients/Students)
router.post('/request', upload.single('attachment'), (req, res) => {
    try {
        const { name, email, company, phone, serviceType, description, expectedDeadline, budgetRange } = req.body;
        if (!name || !email || !description) {
            return res.status(400).json({ error: 'Name, email, and description are required' });
        }

        let attachmentPath = null;
        if (req.file) {
            attachmentPath = '/uploads/materials/' + req.file.filename;
        }

        // Try to associate with logged-in user if token is present
        let clientId = null;
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            const jwt = require('jsonwebtoken');
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET || 'bda-super-secret-key-2025');
                clientId = decoded.id;
            } catch (e) {}
        }

        const result = db.prepare(`
            INSERT INTO consultancy_requests (name, email, company, phone, service_type, description, expected_deadline, budget_range, attachment_path, client_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(name, email, company || null, phone || null, serviceType || null, description, expectedDeadline || null, budgetRange || null, attachmentPath, clientId);

        // Notify admins
        db.prepare('INSERT INTO notifications (role_id, title, message) VALUES (1, ?, ?)').run(
            'New Consultancy Request',
            `A request titled "${company || serviceType || 'Consulting Project'}" has been submitted by ${name}.`
        );

        res.status(201).json({ message: 'Request submitted successfully', requestId: result.lastInsertRowid });
    } catch (err) {
        console.error('Submit consultancy error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/consultancy/projects - View projects list (Admin, Client, Consultant)
router.get('/projects', authenticateToken, (req, res) => {
    try {
        let projects;
        if (req.user.role === 'admin') {
            projects = db.prepare(`
                SELECT cr.*, u.full_name as consultant_name, client.full_name as client_name
                FROM consultancy_requests cr
                LEFT JOIN users u ON cr.assigned_to = u.id
                LEFT JOIN users client ON cr.client_id = client.id
                ORDER BY cr.created_at DESC
            `).all();
        } else if (req.user.role === 'consultant') {
            projects = db.prepare(`
                SELECT cr.*, client.full_name as client_name
                FROM consultancy_requests cr
                LEFT JOIN users client ON cr.client_id = client.id
                WHERE cr.assigned_to = ?
                ORDER BY cr.created_at DESC
            `).all(req.user.id);
        } else {
            // Clients or Students viewing their requests
            projects = db.prepare(`
                SELECT cr.*, u.full_name as consultant_name
                FROM consultancy_requests cr
                LEFT JOIN users u ON cr.assigned_to = u.id
                WHERE cr.client_id = ? OR cr.email = ?
                ORDER BY cr.created_at DESC
            `).all(req.user.id, req.user.email || '');
        }

        res.json({ projects });
    } catch (err) {
        console.error('Get consultancy projects error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/consultancy/projects/:id - Details + Message threads
router.get('/projects/:id', authenticateToken, (req, res) => {
    try {
        const project = db.prepare(`
            SELECT cr.*, u.full_name as consultant_name, client.full_name as client_name
            FROM consultancy_requests cr
            LEFT JOIN users u ON cr.assigned_to = u.id
            LEFT JOIN users client ON cr.client_id = client.id
            WHERE cr.id = ?
        `).get(req.params.id);

        if (!project) return res.status(404).json({ error: 'Project not found' });

        // Access check
        const isSelfClient = project.client_id === req.user.id || project.email === req.user.email;
        const isSelfConsultant = project.assigned_to === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isSelfClient && !isSelfConsultant && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized to view this project' });
        }

        const messages = db.prepare(`
            SELECT cm.*, u.full_name as sender_name, r.name as sender_role
            FROM consultancy_messages cm
            JOIN users u ON cm.sender_id = u.id
            JOIN roles r ON u.role_id = r.id
            WHERE cm.request_id = ?
            ORDER BY cm.created_at ASC
        `).all(req.params.id);

        res.json({ project, messages });
    } catch (err) {
        console.error('Get project details error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/consultancy/projects/:id/messages - Send message inside project thread
router.post('/projects/:id/messages', authenticateToken, (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message cannot be empty' });

        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        // Access checks
        const isClient = project.client_id === req.user.id || project.email === req.user.email;
        const isConsultant = project.assigned_to === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isClient && !isConsultant && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('INSERT INTO consultancy_messages (request_id, sender_id, message) VALUES (?, ?, ?)').run(
            req.params.id, req.user.id, message
        );

        // Notify other parties
        if (isClient) {
            if (project.assigned_to) {
                db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                    project.assigned_to,
                    'New message from client',
                    `Client sent a message in project: "${project.company || 'Consulting'}"`
                );
            }
        } else {
            if (project.client_id) {
                db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                    project.client_id,
                    'New message from consultant',
                    `Consultant sent a message in project: "${project.company || 'Consulting'}"`
                );
            }
        }

        res.status(201).json({ message: 'Message sent successfully' });
    } catch (err) {
        console.error('Send chat message error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== WORKFLOW STATUS UPDATES ====================

// Admin: Assign request to Consultant and set invoice amount
router.put('/projects/:id/assign', authenticateToken, requireRole('admin'), (req, res) => {
    try {
        const { consultantId, invoiceAmount } = req.body;
        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        db.prepare(`
            UPDATE consultancy_requests 
            SET assigned_to = ?, invoice_amount = ?, status = 'in_progress'
            WHERE id = ?
        `).run(consultantId || null, invoiceAmount || 0, req.params.id);

        if (consultantId) {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                consultantId,
                'New Project Assigned',
                `You have been assigned to project: "${project.company || 'Consultancy'}"`
            );
        }

        if (project.client_id) {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                project.client_id,
                'Project Updated',
                `Your consultancy request has been assigned to a consultant.`
            );
        }

        res.json({ message: 'Consultant assigned successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin/Consultant: Save project proposal
router.put('/projects/:id/proposal', authenticateToken, (req, res) => {
    try {
        const { proposalText } = req.body;
        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (req.user.role !== 'admin' && project.assigned_to !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('UPDATE consultancy_requests SET proposal_text = ? WHERE id = ?').run(proposalText, req.params.id);

        if (project.client_id) {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                project.client_id,
                'Proposal Generated',
                `A work proposal has been generated for your project: "${project.company || 'Consulting'}"`
            );
        }

        res.json({ message: 'Proposal updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Client: Approve proposal and start work
router.put('/projects/:id/approve', authenticateToken, (req, res) => {
    try {
        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (project.client_id !== req.user.id && project.email !== req.user.email) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare("UPDATE consultancy_requests SET status = 'in_progress' WHERE id = ?").run(req.params.id);

        if (project.assigned_to) {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                project.assigned_to,
                'Client Approved Proposal',
                `Client has approved the proposal. You may begin execution.`
            );
        }

        res.json({ message: 'Proposal approved. Work has started.' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Consultant: Complete project and upload final deliverable reports
router.put('/projects/:id/deliver', authenticateToken, upload.single('deliverable'), (req, res) => {
    try {
        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const isConsultant = project.assigned_to === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isConsultant && !isAdmin) return res.status(403).json({ error: 'Unauthorized' });

        let filePath = project.attachment_path;
        if (req.file) {
            filePath = '/uploads/materials/' + req.file.filename;
        }

        db.prepare(`
            UPDATE consultancy_requests 
            SET status = 'completed', attachment_path = ?
            WHERE id = ?
        `).run(filePath, req.params.id);

        if (project.client_id) {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                project.client_id,
                'Deliverables Ready! 📄',
                `The final reports and deliverables have been uploaded for project: "${project.company || 'Consulting'}"`
            );
        }

        res.json({ message: 'Deliverables delivered and project marked as completed' });
    } catch (err) {
        console.error('Deliver error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Client: Leave feedback and rating
router.put('/projects/:id/feedback', authenticateToken, (req, res) => {
    try {
        const { feedback, rating } = req.body;
        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (project.client_id !== req.user.id && project.email !== req.user.email) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.prepare('UPDATE consultancy_requests SET client_feedback = ?, client_rating = ? WHERE id = ?').run(
            feedback, rating || 5, req.params.id
        );

        res.json({ message: 'Thank you for your feedback!' });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/consultancy/projects/:id/meetings - Get project meetings
router.get('/projects/:id/meetings', authenticateToken, (req, res) => {
    try {
        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const isClient = project.client_id === req.user.id || project.email === req.user.email;
        const isConsultant = project.assigned_to === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isClient && !isConsultant && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const meetings = db.prepare('SELECT * FROM consultancy_meetings WHERE project_id = ? ORDER BY meeting_date ASC').all(req.params.id);
        res.json({ meetings });
    } catch (err) {
        console.error('Get meetings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/consultancy/projects/:id/meetings - Schedule a project meeting
router.post('/projects/:id/meetings', authenticateToken, (req, res) => {
    try {
        const { title, meetingDate, meetingLink } = req.body;
        if (!title || !meetingDate) return res.status(400).json({ error: 'Title and meeting date are required' });

        const project = db.prepare('SELECT * FROM consultancy_requests WHERE id = ?').get(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const isConsultant = project.assigned_to === req.user.id;
        const isAdmin = req.user.role === 'admin';

        if (!isConsultant && !isAdmin) {
            return res.status(403).json({ error: 'Only assigned consultant or admin can schedule meetings' });
        }

        db.prepare('INSERT INTO consultancy_meetings (project_id, title, meeting_date, meeting_link) VALUES (?, ?, ?, ?)').run(
            req.params.id, title, meetingDate, meetingLink || null
        );

        // Notify client
        if (project.client_id) {
            db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(
                project.client_id,
                'New Meeting Scheduled',
                `A new meeting "${title}" has been scheduled for your project on ${meetingDate}.`
            );
        }

        res.status(201).json({ message: 'Meeting scheduled successfully' });
    } catch (err) {
        console.error('Schedule meeting error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
