const axios = require('axios');

class BackupControlClient {
    constructor(backupServerUrl) {
        this.backupServerUrl = backupServerUrl;
    }

    async getBackupData(collection, options = {}) {
        try {
            const { timestamp, query } = options;
            let url = `${this.backupServerUrl}/backup-data/${collection}`;
            
            if (timestamp) {
                url += `?timestamp=${timestamp}`;
            } else if (query) {
                url += `?query=${JSON.stringify(query)}`;
            }

            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            console.error('Error retrieving backup data:', error.response ? error.response.data : error.message);
            throw error;
        }
    }

    async cancelRecentChanges(minutes) {
        try {
            const response = await axios.post(`${this.backupServerUrl}/cancel-changes`, { minutes });
            return response.data;
        } catch (error) {
            console.error('Error cancelling changes:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

// Usage example
async function main() {
    const client = new BackupControlClient('http://backup-server-address:3000');

    try {
        // Get all backup data for a collection
        const allBackups = await client.getBackupData('users');
        console.log('All backups:', allBackups);

        // Get backup data before a specific timestamp
        const oldBackups = await client.getBackupData('users', { timestamp: '2023-05-01T00:00:00Z' });
        console.log('Old backups:', oldBackups);

        // Get backup data matching a query
        const specificBackups = await client.getBackupData('users', { query: { username: 'john_doe' } });
        console.log('Specific backups:', specificBackups);

        // Cancel recent changes
        const cancelResult = await client.cancelRecentChanges(30);
        console.log('Cancel result:', cancelResult);
    } catch (error) {
        console.error('Error in backup control operations:', error);
    }
}

main();