const { MongoClient } = require('mongodb');
const express = require('express');
const logger = require('./logger');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

class BackupEventEmitter extends EventEmitter { }

const backupEvents = new BackupEventEmitter();

class DelayedVersionedBackup {
    constructor(primaryUri, backupDir, delayMinutes = 60, port = 3000,) {
        this.primaryUri = primaryUri;
        this.backupDir = backupDir;
        this.port = port;
        this.delayMinutes = delayMinutes;
        this.app = express();
        this.primaryClient = null;
        this.changeQueue = [];
        this.eventEmitter = backupEvents;
        this.queueFile = path.join(backupDir, 'change_queue.json');
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

    setupRoutes() {
        this.app.get('/backup-data', async (req, res) => {
            try {
                const { collection, query, timestamp } = req.query;
                const backupFile = path.join(this.backupDir, `${collection}_versions.json`);

                const data = await fs.readFile(backupFile, 'utf8');
                let backups = JSON.parse(data);

                // Filter by timestamp if provided
                if (timestamp) {
                    const filterTime = new Date(timestamp).getTime() / 1000; // Convert to seconds
                    backups = backups.filter(b => b.metadata.clusterTime.$timestamp.t <= filterTime);
                }

                // Apply query filter if provided
                if (query) {
                    const queryObj = JSON.parse(query);
                    backups = backups.filter(b => this.matchQuery(b.original.data, queryObj));
                }

                // Sort by clusterTime (most recent first) and get the first item
                const result = backups.sort((a, b) =>
                    b.metadata.clusterTime.$timestamp.t - a.metadata.clusterTime.$timestamp.t ||
                    b.metadata.clusterTime.$timestamp.i - a.metadata.clusterTime.$timestamp.i
                )[0];

                res.json(result || null);
            } catch (error) {
                logger.error('Error fetching data from backup:', error);
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
        const backupFile = path.join(this.backupDir, `${change.ns.coll}_versions.json`);

        try {
            let backups = [];
            try {
                const data = await fs.readFile(backupFile, 'utf8');
                backups = JSON.parse(data);
            } catch (error) {
                // File doesn't exist yet, which is fine for the first backup
            }

            let documentToBackup;

            switch (change.operationType) {
                case 'insert':
                case 'update':
                    documentToBackup = change.fullDocument;
                    break;
                case 'delete':
                    documentToBackup = {
                        _id: change.documentKey._id,
                        isDeleted: true
                    };
                    break;
                default:
                    logger.warn(`Unhandled operation type: ${change.operationType}`);
                    return;
            }

            const dataObject = {
                original: {
                    _id: change.documentKey._id,
                    data: documentToBackup
                },
                metadata: {
                    clusterTime: change.clusterTime,
                    operationType: change.operationType,
                    backupTimestamp: new Date()
                }
            }

            backups.push(dataObject);


            await fs.writeFile(backupFile, JSON.stringify(backups, null, 2));
            logger.info(`Processed ${change.operationType} for ${change.ns.coll} in backup`);
        } catch (error) {
            const errorDetails = {
                operation: change.operationType,
                collection: change.ns.coll,
                documentId: change.documentKey._id,
                timestamp: new Date(),
                error: error.message
            };
            logger.error('Error processing change in backup:', JSON.stringify(errorDetails, null, 2));
            this.eventEmitter.emit('backupError', errorDetails);
        }
    }

    async cancelRecentChanges(minutes) {
        const cutoffTime = new Date(Date.now() - minutes * 60000);
        const files = await fs.readdir(this.backupDir);

        for (const file of files) {
            if (file.endsWith('_versions.json')) {
                const filePath = path.join(this.backupDir, file);
                const data = await fs.readFile(filePath, 'utf8');
                let backups = JSON.parse(data);

                backups = backups.filter(backup => {
                    // Use clusterTime for more precise filtering
                    const backupTime = new Date(backup.metadata.clusterTime.$timestamp.t * 1000);
                    return backupTime < cutoffTime;
                });

                await fs.writeFile(filePath, JSON.stringify(backups, null, 2));
                logger.info(`Updated ${file} - removed ${backups.length} entries older than ${cutoffTime}`);
            }
        }
        logger.info(`Cancelled changes in the last ${minutes} minutes from backup`);
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