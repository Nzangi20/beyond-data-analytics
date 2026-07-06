const rpc = require('sync-rpc');
const path = require('path');

class SyncMysql2 {
    constructor(config) {
        this._client = rpc(path.join(__dirname, 'mysql2-worker.js'), config);
    }

    query(sql, params = []) {
        // Flatten params just in case they are nested or passed as single elements
        const normalizedParams = Array.isArray(params) ? params : [params];
        return this._client({ type: 'query', sql, params: normalizedParams });
    }

    dispose() {
        return this._client({ type: 'dispose' });
    }
}

module.exports = SyncMysql2;
