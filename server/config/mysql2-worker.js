const mysql = require('mysql2/promise');

function init(config) {
    const pool = mysql.createPool({
        ...config,
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 0
    });

    return async function (message) {
        if (message.type === 'query') {
            try {
                const [rows] = await pool.query(message.sql, message.params);
                return rows;
            } catch (err) {
                throw new Error(err.message);
            }
        } else if (message.type === 'dispose') {
            await pool.end();
            return true;
        }
    };
}

module.exports = init;
