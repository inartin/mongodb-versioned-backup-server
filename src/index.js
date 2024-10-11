const { DelayedVersionedBackup } = require('./DelayedVersionedBackup');
const config = require('config');
const backupServer = new DelayedVersionedBackup(
  config.get('primaryMongodbUri'),
  'db',
  config.get('delayMinutes')
);

backupServer.start();
