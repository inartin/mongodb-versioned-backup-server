const { MongoClient } = require('mongodb');
const express = require('express');
const logger = require('./logger');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const EncryptedBackupSystem = require('./EncryptedBackupSystem');
class BackupEventEmitter extends EventEmitter { }

const backupEvents = new BackupEventEmitter();

class DelayedVersionedBackup {
    constructor(primaryUri, backupDir, delayMinutes = 60, port = 3001,encryptionKey) {
        this.primaryUri = primaryUri;
        this.backupDir = backupDir;
        this.port = port;
        this.delayMinutes = delayMinutes;
        this.app = express();
        this.primaryClient = null;
        this.changeQueue = [];
        this.eventEmitter = backupEvents;
        this.queueFile = path.join(backupDir, 'change_queue.json');
        this.encryptedBackup = new EncryptedBackupSystem(backupDir, encryptionKey);
    }

    async start() {
        try {
            await this.loadQueue();
            await this.connectToDatabase();
            this.setupRoutes();
            this.startReplication();
            this.startDelayedProcessing();
            this.startPeriodicQueueSave();
            this.setupGracefulShutdown();
            this.startServer();
        } catch (error) {
            logger.error('Failed to start delayed backup:', error);
        }
    }
    async loadQueue() {
        try {
            const data = await fs.readFile(this.queueFile, 'utf8');
            this.changeQueue = JSON.parse(data);
            logger.info(`Loaded ${this.changeQueue.length} changes from persistent queue`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('Error loading queue:', error);
            }
            this.changeQueue = [];
        }
    }


    async saveQueue() {
        try {
            await atomicSaveQueue(this.queueFile, this.changeQueue);
            logger.info(`Saved ${this.changeQueue.length} changes to persistent queue`);
        } catch (error) {
            logger.error('Error saving queue:', error);
        }
    }

    startPeriodicQueueSave() {
        setInterval(() => this.saveQueue(), 5 * 60 * 1000); // Save to file every 5 minutes
    }

    setupGracefulShutdown() {
        process.on('SIGINT', async () => {
            logger.info('Shutting down gracefully...');
            await this.saveQueue();
            process.exit(0);
        });
    }

    async connectToDatabase() {
        this.primaryClient = await MongoClient.connect(this.primaryUri);
        logger.info('Connected to primary MongoDB instance');
    }

    async ensureBackupDirectory() {
        await fs.mkdir(this.backupDir, { recursive: true });
        logger.info(`Ensured backup directory exists: ${this.backupDir}`);
    }

    matchQuery(document, query) {
        return Object.entries(query).every(([key, value]) =>
            document[key] === value
        );
    }

    setupRoutes() {
        this.app.get('/backup-data', async (req, res) => {
            try {
                const { collection, query, timestamp, allVersions } = req.query;
                const backupFile = path.join(this.backupDir, `${collection}_versions.json`);

                let backups = {};
                try {
                    const data = await this.encryptedBackup.readAndDecrypt(backupFile);
                    backups = JSON.parse(data);
                } catch (error) {
                    logger.error(`Error reading encrypted backup for collection: ${collection}`, error);
                    return res.status(500).json({ error: 'Error reading backup data' });
                }

                let result = [];
                for (const [docId, versions] of Object.entries(backups)) {
                    let filteredVersions = versions;

                    // Filter by timestamp if provided
                    if (timestamp) {
                        const filterTime = new Date(timestamp).getTime() / 1000;
                        filteredVersions = versions.filter(v => v.metadata.clusterTime.$timestamp.t <= filterTime);
                    }

                    // Apply query filter if provided
                    if (query) {
                        const queryObj = JSON.parse(query);
                        filteredVersions = filteredVersions.filter(v => this.matchQuery(v.data, queryObj));
                    }

                    if (filteredVersions.length > 0) {
                        if (allVersions === 'true') {
                            result.push(filteredVersions);
                        } else {
                            result.push(filteredVersions[0]); // Latest version
                        }
                    }
                }

                res.json({ result });
            } catch (error) {
                logger.error('Error fetching data from encrypted backup:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.app.get('/ping', async (req, res) => {
            try {
                res.status(200).json({ result: 'Pong' });
            } catch (error) {
                logger.error('Error fetching data from backup:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });
    }

    async startReplication() {
        try {
            const db = this.primaryClient.db();
            console.log('Setting up change stream...');
            const changeStream = db.watch([], { fullDocument: 'updateLookup' });

            changeStream.on('change', (change) => {
                this.changeQueue.push({
                    ...change,
                    queuedAt: new Date()
                });
                logger.info(`Change queued: ${change.operationType} in ${change.ns.coll}`);
            });
            logger.info('Started watching for changes in primary database');


        } catch (error) {
            logger.info('Error setting up change stream:', error);
        }
    }

    startDelayedProcessing() {
        setInterval(async () => {
            const now = new Date();
            const cutoffTime = new Date(now.getTime() - this.delayMinutes * 60000);

            let processedCount = 0;
            while (this.changeQueue.length > 0 && new Date(this.changeQueue[0].queuedAt) <= cutoffTime) {
                const change = this.changeQueue.shift();
                await this.processChange(change);
                processedCount++;
            }

            if (processedCount > 0) {
                // Save the queue after processing to reflect changes
                await this.saveQueue();
                logger.info(`Processed and removed ${processedCount} changes from queue`);
            }
        }, 60000); // Check every minute
        logger.info(`Started delayed processing with ${this.delayMinutes} minutes delay`);
    }

    async processChange(change) {
        const backupFile = `${change.ns.coll}_versions`;
        let backups = {};

        try {
            const data = await this.encryptedBackup.readAndDecrypt(backupFile);
            if (data.trim()) {  // Check if the file is not empty
                backups = JSON.parse(data);
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.info(`Creating new encrypted backup file for collection: ${change.ns.coll}`);
            } else {
                logger.error(`Error reading encrypted backup file for collection: ${change.ns.coll}`, error);
            }
        }

        const docId = change.documentKey._id.toString();
        if (!backups[docId]) {
            backups[docId] = [];
        }

        backups[docId].push({
            original: change.fullDocument,
            metadata: {
                clusterTime: change.clusterTime,
                operationType: change.operationType,
                backupTimestamp: new Date()
            }
        });

        // Safe comparison function
        const safeCompare = (a, b) => {
            const getTimestamp = (entry) => {
                return entry?.metadata?.clusterTime?.$timestamp?.t || 0;
            };
            const getIncrement = (entry) => {
                return entry?.metadata?.clusterTime?.$timestamp?.i || 0;
            };

            const timeA = getTimestamp(a);
            const timeB = getTimestamp(b);
            if (timeA !== timeB) {
                return timeB - timeA; // Descending order
            }
            return getIncrement(b) - getIncrement(a); // Descending order
        };

        // Sort versions for this document (most recent first)
        backups[docId].sort(safeCompare);


        try {
            await this.encryptedBackup.encryptAndSave(JSON.stringify(backups), backupFile);
            logger.info(`Processed and encrypted ${change.operationType} for ${change.ns.coll} in backup`);
        } catch (error) {
            logger.error(`Error encrypting and saving backup for collection: ${change.ns.coll}`, error);
            this.eventEmitter.emit('backupError', {
                operation: change.operationType,
                collection: change.ns.coll,
                documentId: change.documentKey._id,
                timestamp: new Date(),
                error: error.message
            });
        }
    }

    async cancelRecentChanges(minutes) {
        const cutoffTime = new Date(Date.now() - minutes * 60000);
        const files = await fs.readdir(this.backupDir);

        for (const file of files) {
            if (file.endsWith('_versions.json')) {
                try {
                    const data = await this.encryptedBackup.readAndDecrypt(file);
                    let backups = JSON.parse(data);

                    backups = backups.filter(backup => {
                        // Use clusterTime for more precise filtering
                        const backupTime = new Date(backup.metadata.clusterTime.$timestamp.t * 1000);
                        return backupTime < cutoffTime;
                    });

                    await this.encryptedBackup.encryptAndSave(JSON.stringify(backups), file);
                    logger.info(`Updated encrypted ${file} - removed entries older than ${cutoffTime}`);
                } catch (error) {
                    logger.error(`Error processing encrypted file: ${file}`, error);
                }
            }
        }
        logger.info(`Cancelled changes in the last ${minutes} minutes from encrypted backup`);
    }

    startServer() {
        // Start the Express server
        this.app.listen(this.port, () => {
            logger.info(`Delayed backup server listening on port ${this.port}`);
        });
    }
}

async function atomicSaveQueue(queueFile, data) {
    //Safe save
    const tempFile = `${queueFile}.tmp`;
    try {
        //Write to a temporary file
        await fs.writeFile(tempFile, JSON.stringify(data), 'utf8');
        //Rename the temporary file to the actual file saving the entire queue to file
        await fs.rename(tempFile, queueFile);
    } catch (error) {
        logger.error('Error in atomic save of queue:', error);
        //Clean up the temporary file if an error occurred
        if (await fs.access(tempFile).then(() => true).catch(() => false)) {
            await fs.unlink(tempFile).catch(e => logger.error('Error deleting temp file:', e));
        }
        throw error;
    }
}

module.exports = { DelayedVersionedBackup };