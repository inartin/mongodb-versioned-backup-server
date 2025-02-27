const { DelayedVersionedBackup } = require('./DelayedVersionedBackup');
const config = require('config');
const backupServer = new DelayedVersionedBackup(
    config.get('primaryMongodbUri'),
    config.get('backupDir'),
    config.get('delayMinutes'),
    config.get('port'),
    config.get('encryptionKey'),
    config.get('dbName')
);

backupServer.start();
