const fs = require('fs');
const path = require('path');
const { db } = require('../config/database');

const COURSES_DATA_DIR = path.join(__dirname, '..', '..', 'courses_data');
const MATERIALS_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'materials');

// Ensure upload materials folder exists
if (!fs.existsSync(MATERIALS_UPLOAD_DIR)) {
    fs.mkdirSync(MATERIALS_UPLOAD_DIR, { recursive: true });
}

function parseHtmlQuestions(htmlContent) {
    const startIdx = htmlContent.indexOf('const questionPool = [');
    if (startIdx === -1) return null;
    
    // Find matching closing bracket for the array
    let bracketCount = 1;
    let endIdx = -1;
    
    // Move to the character after '['
    const arrayStart = htmlContent.indexOf('[', startIdx) + 1;
    for (let i = arrayStart; i < htmlContent.length; i++) {
        if (htmlContent[i] === '[') bracketCount++;
        else if (htmlContent[i] === ']') {
            bracketCount--;
            if (bracketCount === 0) {
                endIdx = i;
                break;
            }
        }
    }
    
    if (endIdx === -1) return null;
    
    const arrayStr = htmlContent.substring(arrayStart - 1, endIdx + 1);
    
    // Use Function constructor to safely evaluate this JS array in a local scope
    try {
        const questions = new Function(`return ${arrayStr};`)();
        return questions.map(item => ({
            text: item.q,
            answers: item.options.map((opt, idx) => ({
                text: opt,
                is_correct: idx === item.correct
            }))
        }));
    } catch (e) {
        console.error('Failed to parse question pool via Function eval:', e);
        return null;
    }
}

function importCourses() {
    console.log('🚀 Starting courses import from:', COURSES_DATA_DIR);

    // Ensure the new column exists in local database
    try {
        db.exec("ALTER TABLE exams ADD COLUMN file_path TEXT");
        console.log("✅ Database migrated: added file_path column to exams table");
    } catch (e) {
        // Already exists or another issue, ignore
    }

    if (!fs.existsSync(COURSES_DATA_DIR)) {
        console.error('❌ courses_data directory not found!');
        return;
    }

    const courseFolders = fs.readdirSync(COURSES_DATA_DIR);

    courseFolders.forEach(courseSlug => {
        const coursePath = path.join(COURSES_DATA_DIR, courseSlug);
        const stat = fs.statSync(coursePath);
        if (!stat.isDirectory()) return;

        console.log(`\n📚 Processing Course: ${courseSlug}`);
        const normalizedSlug = courseSlug.toLowerCase().replace(/[\s_]+/g, '-');

        // Find or create tutorial
        let tutorial = db.prepare('SELECT * FROM tutorials WHERE slug = ?').get(normalizedSlug);
        if (!tutorial) {
            // Create default course names mapping
            const defaultNames = {
                'python': 'Python Programming',
                'r-programming': 'R Programming',
                'powerbi': 'Power BI & Data Visualization',
                'excel': 'Advanced Excel for Data Analytics'
            };
            const name = defaultNames[normalizedSlug] || (courseSlug.charAt(0).toUpperCase() + courseSlug.slice(1).replace(/_/g, ' '));
            const icon = 'fas fa-code';
            const color = '#3182ce';

            const insertTut = db.prepare('INSERT INTO tutorials (name, slug, description, icon, color) VALUES (?, ?, ?, ?, ?)');
            const result = insertTut.run(name, normalizedSlug, `${name} Course`, icon, color);
            tutorial = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(result.lastInsertRowid);
            console.log(`✅ Created Tutorial: ${name} (ID: ${tutorial.id})`);
        } else {
            console.log(`ℹ️ Found existing Tutorial: ${tutorial.name} (ID: ${tutorial.id})`);
        }

        const items = fs.readdirSync(coursePath);
        
        // Find if there are any subdirectories
        const subdirs = items.filter(item => {
            const itemPath = path.join(coursePath, item);
            return fs.statSync(itemPath).isDirectory();
        });

        const processModule = (moduleNumber, modulePath, directHtmlPath) => {
            console.log(`  └─ Module ${moduleNumber}:`);

            // Find or create module in database
            let moduleRecord = db.prepare('SELECT * FROM modules WHERE tutorial_id = ? AND module_number = ?').get(tutorial.id, moduleNumber);
            if (!moduleRecord) {
                const title = `Module ${moduleNumber}`;
                const insertMod = db.prepare('INSERT INTO modules (tutorial_id, module_number, title, description) VALUES (?, ?, ?, ?)');
                const result = insertMod.run(tutorial.id, moduleNumber, title, `${title} for ${tutorial.name}`);
                moduleRecord = db.prepare('SELECT * FROM modules WHERE id = ?').get(result.lastInsertRowid);
                console.log(`     ✅ Created Module ${moduleNumber} (ID: ${moduleRecord.id})`);
            } else {
                console.log(`     ℹ️ Found existing Module ${moduleNumber} (ID: ${moduleRecord.id})`);
            }

            // --- Notes / Study Materials Importing ---
            let notesContent = null;
            let notesFilePath = null;
            let notesFileName = null;
            let hasHtmlNotes = false;

            if (directHtmlPath) {
                const destFileName = `${normalizedSlug}_module${moduleNumber}_notes.html`;
                const destPath = path.join(MATERIALS_UPLOAD_DIR, destFileName);
                
                fs.copyFileSync(directHtmlPath, destPath);
                
                notesFilePath = `/uploads/materials/${destFileName}`;
                notesFileName = destFileName;
                hasHtmlNotes = true;
                console.log(`     📝 Found direct HTML study notes file: "${path.basename(directHtmlPath)}". Copied intact to uploads.`);
            } else if (modulePath) {
                const moduleFiles = fs.readdirSync(modulePath);
                const htmlNotesFile = moduleFiles.find(f => f.endsWith('-a.html') || f.toLowerCase().includes('notes.html'));
                
                if (htmlNotesFile) {
                    const srcPath = path.join(modulePath, htmlNotesFile);
                    const destFileName = `${normalizedSlug}_module${moduleNumber}_notes.html`;
                    const destPath = path.join(MATERIALS_UPLOAD_DIR, destFileName);
                    
                    fs.copyFileSync(srcPath, destPath);
                    
                    notesFilePath = `/uploads/materials/${destFileName}`;
                    notesFileName = destFileName;
                    hasHtmlNotes = true;
                    console.log(`     📝 Found HTML study notes file: "${htmlNotesFile}". Copied intact to uploads.`);
                } else {
                    const mdNotesPath = path.join(modulePath, 'notes.md');
                    const txtNotesPath = path.join(modulePath, 'notes.txt');

                    if (fs.existsSync(mdNotesPath)) {
                        notesContent = fs.readFileSync(mdNotesPath, 'utf8');
                    } else if (fs.existsSync(txtNotesPath)) {
                        notesContent = fs.readFileSync(txtNotesPath, 'utf8');
                    }
                }
            }

            if (notesContent || notesFilePath) {
                const existingLesson = db.prepare("SELECT * FROM lessons WHERE module_id = ? AND content_type = 'notes'").get(moduleRecord.id);
                if (existingLesson) {
                    const updateLesson = db.prepare("UPDATE lessons SET title = ?, content_text = ?, file_path = ?, file_name = ? WHERE id = ?");
                    updateLesson.run(
                        hasHtmlNotes ? `Interactive Study Notes - Module ${moduleNumber}` : `Study Notes - Module ${moduleNumber}`, 
                        notesContent, 
                        notesFilePath, 
                        notesFileName, 
                        existingLesson.id
                    );
                    console.log(`     📝 Updated existing study notes (Lesson ID: ${existingLesson.id})`);
                } else {
                    const insertLesson = db.prepare("INSERT INTO lessons (module_id, title, content_type, content_text, file_path, file_name) VALUES (?, ?, 'notes', ?, ?, ?)");
                    insertLesson.run(
                        moduleRecord.id, 
                        hasHtmlNotes ? `Interactive Study Notes - Module ${moduleNumber}` : `Study Notes - Module ${moduleNumber}`, 
                        notesContent, 
                        notesFilePath, 
                        notesFileName
                    );
                    console.log(`     📝 Created new study notes lesson`);
                }
            }

            // --- Exams / Assessment Importing ---
            let examData = null;
            let examFilePath = null;

            if (modulePath) {
                const moduleFiles = fs.readdirSync(modulePath);
                const htmlAssesFile = moduleFiles.find(f => f.toLowerCase().includes('asses') || f.toLowerCase().includes('assessment'));
                const examJsonPath = path.join(modulePath, 'exam.json');

                if (fs.existsSync(examJsonPath)) {
                    try {
                        examData = JSON.parse(fs.readFileSync(examJsonPath, 'utf8'));
                    } catch (e) {
                        console.error(`     ❌ Error parsing exam.json:`, e.message);
                    }
                } else if (htmlAssesFile) {
                    console.log(`     📝 Found HTML assessment file: "${htmlAssesFile}". Copying and injecting submit hook...`);
                    try {
                        const srcPath = path.join(modulePath, htmlAssesFile);
                        const destFileName = `${normalizedSlug}_module${moduleNumber}_asses.html`;
                        const destPath = path.join(MATERIALS_UPLOAD_DIR, destFileName);

                        let htmlContent = fs.readFileSync(srcPath, 'utf8');
                        const parsedQuestions = parseHtmlQuestions(htmlContent);
                        const totalQuestionsCount = (parsedQuestions && parsedQuestions.length) ? parsedQuestions.length : 20;

                        const scriptInjection = `
<script>
    (function() {
        const originalShowResults = window.showResults;
        window.showResults = function(score, percentage, passed) {
            if (typeof originalShowResults === 'function') {
                originalShowResults(score, percentage, passed);
            }

            const btn = document.getElementById('modal-btn');
            if (btn) {
                btn.onclick = function() {
                    if (window.opener) {
                        try {
                            if (typeof window.opener.loadContent === 'function') {
                                window.opener.loadContent();
                            } else if (typeof window.opener.loadDashboard === 'function') {
                                window.opener.loadDashboard();
                            } else {
                                window.opener.location.reload();
                            }
                        } catch (e) {}
                    }
                    if (passed) {
                        window.close();
                    } else {
                        location.reload();
                    }
                };
            }

            const token = localStorage.getItem('bda_token') || localStorage.getItem('token');
            if (token) {
                fetch('/api/exams/external-submit', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({
                        tutorialSlug: '${normalizedSlug}',
                        moduleNumber: ${moduleNumber},
                        score: score,
                        percentage: percentage,
                        passed: passed
                    })
                })
                .then(res => res.json())
                .then(data => {
                    console.log('Exam progress submitted successfully:', data);
                    if (window.opener) {
                        try {
                            if (typeof window.opener.loadContent === 'function') {
                                window.opener.loadContent();
                            } else if (typeof window.opener.loadDashboard === 'function') {
                                window.opener.loadDashboard();
                            } else {
                                window.opener.location.reload();
                            }
                        } catch (e) {}
                    }
                })
                .catch(err => {
                    console.error('Failed to submit exam progress:', err);
                });
            }
        };
    })();
</script>
`;
                        const bodyCloseIdx = htmlContent.toLowerCase().lastIndexOf('</body>');
                        if (bodyCloseIdx !== -1) {
                            htmlContent = htmlContent.substring(0, bodyCloseIdx) + scriptInjection + htmlContent.substring(bodyCloseIdx);
                        } else {
                            htmlContent += scriptInjection;
                        }

                        fs.writeFileSync(destPath, htmlContent, 'utf8');
                        examFilePath = `/uploads/materials/${destFileName}`;

                        examData = {
                            title: `Module ${moduleNumber} Assessment`,
                            time_limit: 30,
                            total_marks: totalQuestionsCount,
                            questions: parsedQuestions || []
                        };
                    } catch (e) {
                        console.error(`     ❌ Error reading/parsing HTML assessment file:`, e.message);
                    }
                }
            }

            if (examData) {
                let examRecord = db.prepare('SELECT * FROM exams WHERE module_id = ?').get(moduleRecord.id);
                if (examRecord) {
                    const updateExam = db.prepare('UPDATE exams SET title = ?, time_limit = ?, total_marks = ?, file_path = ? WHERE id = ?');
                    updateExam.run(examData.title || `Module ${moduleNumber} Exam`, examData.time_limit || 60, examData.total_marks || 100, examFilePath, examRecord.id);
                    console.log(`     📝 Updated existing exam: "${examData.title}"`);
                } else {
                    const insertExam = db.prepare('INSERT INTO exams (module_id, title, time_limit, total_marks, file_path) VALUES (?, ?, ?, ?, ?)');
                    const result = insertExam.run(moduleRecord.id, examData.title || `Module ${moduleNumber} Exam`, examData.time_limit || 60, examData.total_marks || 100, examFilePath);
                    examRecord = db.prepare('SELECT * FROM exams WHERE id = ?').get(result.lastInsertRowid);
                    console.log(`     📝 Created new exam: "${examData.title}"`);
                }

                db.prepare('DELETE FROM questions WHERE exam_id = ?').run(examRecord.id);

                if (Array.isArray(examData.questions) && examData.questions.length > 0) {
                    examData.questions.forEach((q, qIndex) => {
                        const insertQuestion = db.prepare(`
                            INSERT INTO questions (exam_id, question_text, question_type, marks, order_num) 
                            VALUES (?, ?, 'mcq', 1, ?)
                        `);
                        const qResult = insertQuestion.run(examRecord.id, q.text, qIndex);
                        const questionId = qResult.lastInsertRowid;

                        if (Array.isArray(q.answers)) {
                            q.answers.forEach((ans, ansIndex) => {
                                const insertAnswer = db.prepare(`
                                    INSERT INTO answers (question_id, answer_text, is_correct, order_num) 
                                    VALUES (?, ?, ?, ?)
                                `);
                                insertAnswer.run(questionId, ans.text, ans.is_correct ? 1 : 0, ansIndex);
                            });
                        }
                    });
                    console.log(`     ✅ Imported ${examData.questions.length} questions into the assessment`);
                }
            }
        };

        if (subdirs.length > 0) {
            subdirs.forEach(moduleFolderName => {
                const modulePath = path.join(coursePath, moduleFolderName);
                const numMatch = moduleFolderName.match(/\d+/);
                if (!numMatch) {
                    console.log(`⚠️ Skipping folder with invalid name format: ${moduleFolderName}`);
                    return;
                }
                const moduleNumber = parseInt(numMatch[0]);
                processModule(moduleNumber, modulePath, null);
            });
        } else {
            items.forEach(fileName => {
                if (!fileName.toLowerCase().endsWith('.html')) return;
                const numMatch = fileName.match(/Module\s*(\d+)/i);
                if (!numMatch) {
                    console.log(`⚠️ Skipping file with invalid name format: ${fileName}`);
                    return;
                }
                const moduleNumber = parseInt(numMatch[1]);
                const filePath = path.join(coursePath, fileName);
                processModule(moduleNumber, null, filePath);
            });
        }
    });

    console.log('\n🏁 Course import process finished!');
}

importCourses();
