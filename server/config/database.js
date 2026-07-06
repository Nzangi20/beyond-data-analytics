const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'bda.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent performance
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function initializeDatabase() {
    db.exec(`
        -- Roles table
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT
        );

        -- Users table
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT UNIQUE,
            full_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role_id INTEGER NOT NULL DEFAULT 2,
            first_login INTEGER NOT NULL DEFAULT 1,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (role_id) REFERENCES roles(id),
            FOREIGN KEY (created_by) REFERENCES users(id)
        );

        -- Tutorials table (Python, R, SQL, Power BI)
        CREATE TABLE IF NOT EXISTS tutorials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            description TEXT,
            icon TEXT DEFAULT 'fas fa-code',
            color TEXT DEFAULT '#3182ce',
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Modules table (4 per tutorial)
        CREATE TABLE IF NOT EXISTS modules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tutorial_id INTEGER NOT NULL,
            module_number INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            pass_mark INTEGER NOT NULL DEFAULT 70,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE,
            UNIQUE(tutorial_id, module_number)
        );

        -- Lessons/Materials table
        CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            content_type TEXT NOT NULL CHECK(content_type IN ('notes', 'video', 'exercise', 'material')),
            content_text TEXT,
            file_path TEXT,
            file_name TEXT,
            order_num INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        -- Student tutorial enrollment
        CREATE TABLE IF NOT EXISTS user_tutorials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tutorial_id INTEGER NOT NULL,
            enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE,
            UNIQUE(user_id, tutorial_id)
        );

        -- Exams table (1 per module)
        CREATE TABLE IF NOT EXISTS exams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            module_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            time_limit INTEGER DEFAULT 60,
            total_marks INTEGER NOT NULL DEFAULT 100,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
        );

        -- Questions table
        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_id INTEGER NOT NULL,
            question_text TEXT NOT NULL,
            question_type TEXT NOT NULL CHECK(question_type IN ('mcq', 'true_false', 'practical')),
            marks INTEGER NOT NULL DEFAULT 1,
            explanation TEXT,
            order_num INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
        );

        -- Answers/Options table
        CREATE TABLE IF NOT EXISTS answers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id INTEGER NOT NULL,
            answer_text TEXT NOT NULL,
            is_correct INTEGER NOT NULL DEFAULT 0,
            order_num INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );

        -- Student progress per module
        CREATE TABLE IF NOT EXISTS student_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            module_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked', 'unlocked', 'in_progress', 'completed', 'failed')),
            score REAL,
            attempts INTEGER NOT NULL DEFAULT 0,
            completed_at DATETIME,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
            UNIQUE(user_id, module_id)
        );

        -- Exam attempts
        CREATE TABLE IF NOT EXISTS exam_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            exam_id INTEGER NOT NULL,
            score REAL NOT NULL DEFAULT 0,
            total_marks INTEGER NOT NULL DEFAULT 0,
            percentage REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'auto_submitted')),
            violations_count INTEGER NOT NULL DEFAULT 0,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
        );

        -- Individual question responses within an attempt
        CREATE TABLE IF NOT EXISTS exam_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            attempt_id INTEGER NOT NULL,
            question_id INTEGER NOT NULL,
            selected_answer_id INTEGER,
            is_correct INTEGER NOT NULL DEFAULT 0,
            attempts_used INTEGER NOT NULL DEFAULT 1,
            answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (attempt_id) REFERENCES exam_attempts(id) ON DELETE CASCADE,
            FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );

        -- Certificates
        CREATE TABLE IF NOT EXISTS certificates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tutorial_id INTEGER NOT NULL,
            cert_number TEXT NOT NULL UNIQUE,
            qr_data TEXT,
            issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE,
            UNIQUE(user_id, tutorial_id)
        );

        -- Activity logs
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        -- Exam violations
        CREATE TABLE IF NOT EXISTS violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            attempt_id INTEGER NOT NULL,
            violation_type TEXT NOT NULL,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (attempt_id) REFERENCES exam_attempts(id) ON DELETE CASCADE
        );

        -- Consultancy requests
        CREATE TABLE IF NOT EXISTS consultancy_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            company TEXT,
            phone TEXT,
            service_type TEXT,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
            assigned_to INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
        );

        -- Mentor-student assignments
        CREATE TABLE IF NOT EXISTS mentor_students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mentor_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (mentor_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(mentor_id, student_id)
        );

        -- Payments table (updated with CHECK constraint to support 'enrollment')
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            target_type TEXT NOT NULL CHECK(target_type IN ('certificate', 'consultancy', 'enrollment')),
            target_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            payment_method TEXT NOT NULL CHECK(payment_method IN ('M-Pesa', 'PayPal', 'Card', 'Bank')),
            transaction_ref TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'refunded')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );


        -- News articles table
        CREATE TABLE IF NOT EXISTS news_articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('General News', 'Course Updates', 'Events', 'Consultancy Updates', 'Community Activities', 'System Notices')),
            author_id INTEGER NOT NULL,
            is_published INTEGER NOT NULL DEFAULT 1,
            file_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Announcements table
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'Medium' CHECK(priority IN ('Low', 'Medium', 'High')),
            expiry_date DATETIME,
            image_path TEXT,
            file_path TEXT,
            link_url TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Notifications table
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            role_id INTEGER,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
        );

        -- Consultancy messages table
        CREATE TABLE IF NOT EXISTS consultancy_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (request_id) REFERENCES consultancy_requests(id) ON DELETE CASCADE,
            FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Course-Instructor assignments
        CREATE TABLE IF NOT EXISTS tutorial_instructors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tutorial_id INTEGER NOT NULL,
            instructor_id INTEGER NOT NULL,
            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE,
            FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(tutorial_id, instructor_id)
        );

        -- Workshops/Webinars table
        CREATE TABLE IF NOT EXISTS workshops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            tutorial_id INTEGER NOT NULL,
            instructor_id INTEGER,
            schedule_date DATETIME NOT NULL,
            meeting_link TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE,
            FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE SET NULL
        );

        -- Mentorship sessions table
        CREATE TABLE IF NOT EXISTS mentorship_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mentor_id INTEGER NOT NULL,
            student_id INTEGER NOT NULL,
            topic TEXT NOT NULL,
            schedule_date DATETIME NOT NULL,
            meeting_link TEXT,
            status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'completed', 'cancelled')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (mentor_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Universal messages table
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            subject TEXT,
            message_text TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Consultancy meetings table
        CREATE TABLE IF NOT EXISTS consultancy_meetings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            meeting_date DATETIME NOT NULL,
            meeting_link TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES consultancy_requests(id) ON DELETE CASCADE
        );
    `);

    // Run table alterations for backward compatibility
    try { db.exec("ALTER TABLE tutorials ADD COLUMN certificate_fee REAL DEFAULT 2000.0"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN organization TEXT"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN expected_deadline DATE"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN budget_range TEXT"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN attachment_path TEXT"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN proposal_text TEXT"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN client_feedback TEXT"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN client_rating INTEGER"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN invoice_amount REAL DEFAULT 0.0"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN payment_status TEXT DEFAULT 'unpaid'"); } catch(e){}
    try { db.exec("ALTER TABLE consultancy_requests ADD COLUMN client_id INTEGER REFERENCES users(id) ON DELETE SET NULL"); } catch(e){}
    try { db.exec("ALTER TABLE news_articles ADD COLUMN file_path TEXT"); } catch(e){}

    // Payments CHECK constraint migration for 'enrollment'
    try {
        const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'").get();
        if (schema && !schema.sql.includes('enrollment')) {
            db.exec("ALTER TABLE payments RENAME TO payments_old");
            db.exec(`
                CREATE TABLE payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    target_type TEXT NOT NULL CHECK(target_type IN ('certificate', 'consultancy', 'enrollment')),
                    target_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    payment_method TEXT NOT NULL CHECK(payment_method IN ('M-Pesa', 'PayPal', 'Card', 'Bank')),
                    transaction_ref TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'refunded')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
            `);
            db.exec("INSERT OR IGNORE INTO payments (id, user_id, target_type, target_id, amount, payment_method, transaction_ref, status, created_at) SELECT id, user_id, target_type, target_id, amount, payment_method, transaction_ref, status, created_at FROM payments_old");
            db.exec("DROP TABLE payments_old");
            console.log("Migrated payments table successfully");
        }
    } catch(e) {
        console.error("Migration of payments table failed:", e);
    }

    // New columns for dual learning modes and fees
    try { db.exec("ALTER TABLE tutorials ADD COLUMN enrollment_fee REAL DEFAULT 5000.0"); } catch(e){}
    try { db.exec("ALTER TABLE exams ADD COLUMN file_path TEXT"); } catch(e){}
    try { db.exec("ALTER TABLE user_tutorials ADD COLUMN learning_mode TEXT DEFAULT 'self' CHECK(learning_mode IN ('self', 'enrolled'))"); } catch(e){}
    try { db.exec("ALTER TABLE user_tutorials ADD COLUMN payment_status TEXT DEFAULT 'unpaid'"); } catch(e){}

    // Create assignments tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tutorial_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            file_path TEXT,
            due_date DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS student_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            submission_text TEXT,
            file_path TEXT,
            grade TEXT,
            feedback TEXT,
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            graded_at DATETIME,
            FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(assignment_id, user_id)
        );
    `);


    // Seed default roles
    try { db.exec("UPDATE roles SET name = 'mentor', description = 'Mentor' WHERE id = 3"); } catch(e){}
    const insertRole = db.prepare('INSERT OR IGNORE INTO roles (id, name, description) VALUES (?, ?, ?)');
    insertRole.run(1, 'admin', 'System Administrator');
    insertRole.run(2, 'student', 'Student/Learner');
    insertRole.run(3, 'mentor', 'Mentor');
    insertRole.run(4, 'consultant', 'Consultant');
    insertRole.run(5, 'client', 'Consultancy Client');
    insertRole.run(6, 'instructor', 'Instructor');

    // Seed default admin user
    const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!adminExists) {
        const hash = bcrypt.hashSync(process.env.ADMIN_DEFAULT_PASSWORD || 'BDA@Admin2025', 12);
        db.prepare(`
            INSERT INTO users (username, email, full_name, password_hash, role_id, first_login)
            VALUES (?, ?, ?, ?, 1, 0)
        `).run('admin', 'admin@beyonddataanalytics.online', 'System Administrator', hash);
        console.log('✅ Default admin account created (username: admin)');
    }

    // Seed default tutorials
    const insertTutorial = db.prepare('INSERT OR IGNORE INTO tutorials (name, slug, description, icon, color, enrollment_fee, certificate_fee) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertTutorial.run('Python for Data Science', 'python', 'Master Python programming for data science, machine learning, and automation.', 'fab fa-python', '#3776ab', 30000.0, 2000.0);
    insertTutorial.run('R Programming', 'r-programming', 'Learn R for statistical computing, data visualization, and biostatistics.', 'fas fa-chart-area', '#276dc3', 30000.0, 2000.0);
    insertTutorial.run('SQL', 'sql', 'Master database querying, management, and data manipulation with SQL.', 'fas fa-database', '#e48e00', 30000.0, 2000.0);
    insertTutorial.run('Power BI', 'power-bi', 'Create stunning dashboards and business intelligence reports with Power BI.', 'fas fa-chart-pie', '#f2c811', 30000.0, 2000.0);
    insertTutorial.run('Data Analysis Fundamentals', 'data-analysis-fundamentals', 'Master the basics of data analysis, Excel, SQL, and data visualization.', 'fas fa-chart-bar', '#3182ce', 25000.0, 2000.0);
    insertTutorial.run('Machine Learning Bootcamp', 'machine-learning-bootcamp', 'Build intelligent predictive models and learn machine learning algorithms.', 'fas fa-brain', '#d69e2e', 45000.0, 2000.0);
    insertTutorial.run('Time Series Forecasting', 'time-series-forecasting', 'Predict future trends accurately using statistical and deep learning models.', 'fas fa-clock', '#e53e3e', 35000.0, 2000.0);
    insertTutorial.run('Statistical Inference', 'statistical-inference', 'Deep dive into hypothesis testing, regression analysis, and experimental design.', 'fas fa-microscope', '#3182ce', 32000.0, 2000.0);
    insertTutorial.run('Survival Analysis', 'survival-analysis', 'Time-to-event modeling, Kaplan-Meier estimation, and health data applications.', 'fas fa-heartbeat', '#d69e2e', 38000.0, 2000.0);

    // Seed 4 modules per tutorial
    const tutorials = db.prepare('SELECT id, name FROM tutorials').all();
    const insertModule = db.prepare('INSERT OR IGNORE INTO modules (tutorial_id, module_number, title, description) VALUES (?, ?, ?, ?)');

    const moduleTemplates = [
        { num: 1, suffix: 'Fundamentals', desc: 'Core concepts, setup, and basic operations' },
        { num: 2, suffix: 'Intermediate', desc: 'Data manipulation, functions, and control flow' },
        { num: 3, suffix: 'Advanced', desc: 'Advanced techniques, libraries, and optimization' },
        { num: 4, suffix: 'Projects & Applications', desc: 'Real-world projects and capstone assignments' }
    ];

    tutorials.forEach(t => {
        moduleTemplates.forEach(m => {
            insertModule.run(t.id, m.num, `${t.name} ${m.suffix}`, m.desc);
        });
    });

    // Seed some lessons if table is empty
    const lessonsCount = db.prepare('SELECT COUNT(*) as count FROM lessons').get().count;
    if (lessonsCount === 0) {
        const insertLesson = db.prepare(`
            INSERT INTO lessons (module_id, title, content_type, content_text, file_path, file_name, order_num)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        
        const modulesList = db.prepare(`
            SELECT m.id, t.slug, m.module_number
            FROM modules m
            JOIN tutorials t ON m.tutorial_id = t.id
            WHERE m.module_number = 1
        `).all();
        
        modulesList.forEach(mod => {
            if (mod.slug === 'python') {
                insertLesson.run(mod.id, 'Introduction to Python & Setup', 'notes', 
                    'Python is an interpreted, high-level, general-purpose programming language. Created by Guido van Rossum and first released in 1991.\n\nTo setup Python on your system:\n1. Download Python from python.org\n2. Install it and ensure "Add Python to PATH" is checked.\n3. Verify installation using command: python --version', 
                    null, null, 1);
                
                insertLesson.run(mod.id, 'Python Syntax and Variables Video', 'video', 
                    'Learn variables, data types, and operators in Python.', 
                    '/uploads/videos/python_intro.mp4', 'python_intro.mp4', 2);
                
                insertLesson.run(mod.id, 'Variables and Operators Exercises', 'exercise', 
                    'Task 1:\nCreate a variable named "age" and assign the value 25 to it.\nTask 2:\nCreate variables "x" = 10 and "y" = 3. Compute the modulus of x and y and print it.', 
                    null, null, 3);
                
                insertLesson.run(mod.id, 'Official Python Cheat Sheet', 'material', 
                    'Official Python cheatsheet covering basics, lists, dicts, loops and functions.', 
                    '/uploads/documents/python_cheat_sheet.pdf', 'python_cheat_sheet.pdf', 4);
            } else if (mod.slug === 'r-programming') {
                insertLesson.run(mod.id, 'Getting Started with R & RStudio', 'notes', 
                    'R is a programming language and free software environment for statistical computing and graphics.\n\nRStudio is the most popular integrated development environment (IDE) for R.', 
                    null, null, 1);
                insertLesson.run(mod.id, 'Data Types & Vectors Exercise', 'exercise', 
                    'Task 1:\nCreate a vector of numbers from 1 to 10.\nTask 2:\nCalculate the mean of the vector using mean() function.', 
                    null, null, 2);
            } else if (mod.slug === 'sql') {
                insertLesson.run(mod.id, 'Introduction to SQL and SELECT Queries', 'notes', 
                    'SQL (Structured Query Language) is the standard language for relational database management systems.\n\nBasic syntax:\nSELECT column1, column2 FROM table_name WHERE condition;', 
                    null, null, 1);
                insertLesson.run(mod.id, 'Querying Employees Database', 'exercise', 
                    'Write a SQL query to select all employees from the "sales" department with salary greater than 50000.', 
                    null, null, 2);
            }
        });
        console.log('✅ Default study materials and lessons seeded');
    }

    // Seed default exams & questions if questions table is empty
    const questionsCount = db.prepare('SELECT COUNT(*) as count FROM questions').get().count;
    if (questionsCount === 0) {
        // First delete any incomplete/dummy exams to avoid duplication issues
        db.exec("DELETE FROM exams");
        db.exec("DELETE FROM questions");
        db.exec("DELETE FROM answers");

        const insertExam = db.prepare(`
            INSERT INTO exams (module_id, title, description, time_limit, total_marks)
            VALUES (?, ?, ?, ?, ?)
        `);
        const insertQuestion = db.prepare(`
            INSERT INTO questions (exam_id, question_text, question_type, marks, order_num)
            VALUES (?, ?, ?, ?, ?)
        `);
        const insertAnswer = db.prepare(`
            INSERT INTO answers (question_id, answer_text, is_correct, order_num)
            VALUES (?, ?, ?, ?)
        `);

        // Find Module 1 for Python, R, SQL
        const modulesList = db.prepare(`
            SELECT m.id, t.slug, m.title
            FROM modules m
            JOIN tutorials t ON m.tutorial_id = t.id
            WHERE m.module_number = 1
        `).all();

        modulesList.forEach(mod => {
            if (mod.slug === 'python') {
                const examResult = insertExam.run(mod.id, 'Python Fundamentals Exam', 'Test your knowledge on basic Python variables, types, and loops.', 15, 3);
                const examId = examResult.lastInsertRowid;

                // Question 1
                const q1Result = insertQuestion.run(examId, 'What is the correct way to assign the value 5 to a variable named x in Python?', 'mcq', 1, 1);
                const q1Id = q1Result.lastInsertRowid;
                insertAnswer.run(q1Id, 'x = 5', 1, 1);
                insertAnswer.run(q1Id, 'var x = 5', 0, 2);
                insertAnswer.run(q1Id, 'x := 5', 0, 3);
                insertAnswer.run(q1Id, 'int x = 5', 0, 4);

                // Question 2
                const q2Result = insertQuestion.run(examId, 'Python is an interpreted language.', 'true_false', 1, 2);
                const q2Id = q2Result.lastInsertRowid;
                insertAnswer.run(q2Id, 'True', 1, 1);
                insertAnswer.run(q2Id, 'False', 0, 2);

                // Question 3
                const q3Result = insertQuestion.run(examId, 'Which operator is used for calculating the remainder (modulus) of a division in Python?', 'mcq', 1, 3);
                const q3Id = q3Result.lastInsertRowid;
                insertAnswer.run(q3Id, '%', 1, 1);
                insertAnswer.run(q3Id, '/', 0, 2);
                insertAnswer.run(q3Id, '//', 0, 3);
                insertAnswer.run(q3Id, '^', 0, 4);
                
            } else if (mod.slug === 'r-programming') {
                const examResult = insertExam.run(mod.id, 'R Programming Basics Exam', 'Test your knowledge on vectors, matrices, and basic syntax in R.', 15, 2);
                const examId = examResult.lastInsertRowid;

                // Question 1
                const q1Result = insertQuestion.run(examId, 'Which of the following is the standard assignment operator in R?', 'mcq', 1, 1);
                const q1Id = q1Result.lastInsertRowid;
                insertAnswer.run(q1Id, '<-', 1, 1);
                insertAnswer.run(q1Id, '==', 0, 2);
                insertAnswer.run(q1Id, '=', 0, 3);
                insertAnswer.run(q1Id, 'set', 0, 4);

                // Question 2
                const q2Result = insertQuestion.run(examId, 'R is case-sensitive (meaning VAR and var are different).', 'true_false', 1, 2);
                const q2Id = q2Result.lastInsertRowid;
                insertAnswer.run(q2Id, 'True', 1, 1);
                insertAnswer.run(q2Id, 'False', 0, 2);

            } else if (mod.slug === 'sql') {
                const examResult = insertExam.run(mod.id, 'SQL Fundamentals Exam', 'Test your knowledge on SELECT, WHERE, and SQL basics.', 15, 2);
                const examId = examResult.lastInsertRowid;

                // Question 1
                const q1Result = insertQuestion.run(examId, 'Which SQL clause is used to filter query results?', 'mcq', 1, 1);
                const q1Id = q1Result.lastInsertRowid;
                insertAnswer.run(q1Id, 'WHERE', 1, 1);
                insertAnswer.run(q1Id, 'ORDER BY', 0, 2);
                insertAnswer.run(q1Id, 'GROUP BY', 0, 3);
                insertAnswer.run(q1Id, 'FILTER', 0, 4);

                // Question 2
                const q2Result = insertQuestion.run(examId, 'The SELECT statement is used to retrieve data from a database.', 'true_false', 1, 2);
                const q2Id = q2Result.lastInsertRowid;
                insertAnswer.run(q2Id, 'True', 1, 1);
                insertAnswer.run(q2Id, 'False', 0, 2);
            }
        });
        console.log('✅ Default exam questions and answers seeded successfully');
    }

    console.log('✅ Database initialized successfully');
}

module.exports = { db, initializeDatabase };
