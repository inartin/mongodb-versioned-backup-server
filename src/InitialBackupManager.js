const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger');

class InitialBackupManager extends EventEmitter {
    constructor(primaryClient, backupDir, encryptedBackup, dbName) {
        super();
        this.primaryClient = primaryClient;
        this.backupDir = backupDir;
        this.encryptedBackup = encryptedBackup;
        this.dbName = dbName;
        this.metadataFile = path.join(this.backupDir, 'initial_backup_metadata.json');
    }

    async performInitialBackup() {
        try {

            let backupMetadata = await this.loadOrInitializeMetadata();

            const db = this.primaryClient.db(this.dbName);
            const collections = await db.listCollections().toArray();
            const totalCollections = collections.length;
            await this.updateTotalDocumentCount(db, collections, backupMetadata);

            for (const collInfo of collections) {
                const collectionName = collInfo.name;

                if (backupMetadata.processedCollections.includes(collectionName)) {
                    logger.info(`Skipping already backed up collection: ${collectionName}`);
                    continue;
                }

                await this.backupCollection(db, collectionName, backupMetadata, totalCollections);
            }

            await this.finalizeBackup(backupMetadata, totalCollections);

        } catch (error) {
            logger.error('Error performing initial backup:', error);
            this.emit('backupError', {
                phase: 'initialBackup',
                error: error.message
            });
            throw error;
        }
    }

    async loadOrInitializeMetadata() {
        try {
            // Check if the metadata file exists
            await fs.access(this.metadataFile);
            const metadataContent = await fs.readFile(this.metadataFile, 'utf8');
            const metadata = JSON.parse(metadataContent);
            return metadata;
        } catch (error) {
            const newMetadata = {
                startTime: new Date().toISOString(),
                processedCollections: [],
                totalDocuments: 0,
                processedDocuments: 0
            };
            try {
                // Only write the file (no directory creation logic)
                await fs.writeFile(this.metadataFile, JSON.stringify(newMetadata, null, 2));
                // Verify the file was created
                await fs.access(this.metadataFile);
                logger.info(`New metadata file created and verified successfully at: ${this.metadataFile}`);
            } catch (saveError) {
                logger.error('Failed to save or verify new metadata file:', saveError);
                throw saveError;
            }

            return newMetadata;
        }
    }

    async updateTotalDocumentCount(db, collections, metadata) {
        let updated = false;
        for (const collInfo of collections) {
            if (!metadata.processedCollections.includes(collInfo.name)) {
                const count = await db.collection(collInfo.name).countDocuments();
                metadata.totalDocuments += count;
                updated = true;
            }
        }

        if (updated) {
            try {
                await fs.writeFile(this.metadataFile, JSON.stringify(metadata, null, 2));
                logger.info(`Updated metadata file with new total document count: ${metadata.totalDocuments}`);
            } catch (error) {
                logger.error('Failed to update metadata file with new total document count:', error);
                throw error; // or handle it according to your error management strategy
            }
        }
    }

    async backupCollection(db, collectionName, metadata, totalCollections) {
        logger.info(`Backing up collection: ${collectionName}`);

        const documents = await db.collection(collectionName).find({}).toArray();
        const backupData = {};

        for (const [index, doc] of documents.entries()) {
            const docId = doc._id.toString();
            backupData[docId] = [{
                original: doc,
                metadata: {
                    clusterTime: { $timestamp: { t: Math.floor(Date.now() / 1000), i: 0 } },
                    operationType: 'initialBackup',
                    backupTimestamp: new Date()
                }
            }];

            metadata.processedDocuments++;

            if (index % 100 === 0 || index === documents.length - 1) {
                await this.emitProgress(metadata, collectionName, totalCollections);
            }
        }

        const backupFileName = `${collectionName}_versions`;
        await this.encryptedBackup.encryptAndSave(JSON.stringify(backupData), backupFileName);

        metadata.processedCollections.push(collectionName);
        await fs.writeFile(this.metadataFile,JSON.stringify(metadata, null, 2));

        logger.info(`Completed backup of collection: ${collectionName}`);
    }

    async emitProgress(metadata, currentCollection, totalCollections) {
        const progress = {
            phase: 'initialBackup',
            currentCollection,
            processedCollections: metadata.processedCollections.length,
            totalCollections,
            processedDocuments: metadata.processedDocuments,
            totalDocuments: metadata.totalDocuments,
            percentComplete: ((metadata.processedDocuments / metadata.totalDocuments) * 100).toFixed(2)
        };
        this.emit('backupProgress', progress);
        logger.info(`Backup progress: ${JSON.stringify(progress)}`);
    }

    async finalizeBackup(metadata, totalCollections) {
        logger.info('Initial full backup completed successfully');
        this.emit('backupProgress', {
            phase: 'initialBackup',
            status: 'completed',
            processedCollections: metadata.processedCollections.length,
            totalCollections,
            processedDocuments: metadata.processedDocuments,
            totalDocuments: metadata.totalDocuments
        });
        try {
            await fs.access(this.metadataFile);
            // If the file exists, delete it
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist, create an empty one
                await fs.writeFile(this.metadataFile, '{}');
            } else {
                // If there's any other error, log it
                console.error('Error handling metadata file:', error);
            }
        }
    }
}

module.exports = InitialBackupManager;