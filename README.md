# Backup App Overview

The backup app listens for all MongoDB changes and manages backups with a delay.

### Key Features:
- **Data Encryption**

- **Data Queuing**: 
    - All data changes are added to a queue for 1 hour before being saved to `collectionName_versions.json` file.

- **Queue Persistence**:
    - The queued data is saved to `change_queue.json` every 5 minutes. In case of a graceful shutdown, all queued changes are saved.

- **Versioned Backup**:
    - Each time a document changes (insert, update, or delete), a new "version" of that document is added to the backup. These versions are stored in an array, with the history of changes for each document.
    - Backups are stored as an object where each key is a document ID, and the value is an array of versions for that document.
    - When retreiving data, by default latest modified/created version will return. Optionally you can add allVersions=true parameter and you will get the history of all changes

- **Deleted Data Handling**:
    - Deleted data from the database is marked with `isDeleted: true` but is never removed from the backup file.

- **Logs**:
    - All logs can be found in the `backup-server.log` file.

### Starting the Server:
1. The entry point for the server is located at `./src/index.js`.
2. The `DelayedVersionedBackup` class manages the server setup and accepts 4 parameters:
    - `MongodbUri` (string): The MongoDB connection URI.
    - `Path` (string): Path for storing backup files.
    - `Delay` (integer): The delay in minutes for saving queued data.
    - `Port` (integer): Port for server to use

### Remote Server Usage:

*TO DO*: Implement access control, e.g., with a secret key.

- **Get Data from Backup**:
    ```js
    axios.get(`${backupServerUrl}/backup-data?collection=${collectionName}&timestamp=${timestamp}`)
    ```
    - Optional: Add query parameters. Example:
    ```js
    &query=${encodeURIComponent(JSON.stringify({ query: { username: 'john_doe' } }))}
    ```

- **Cancel Saving Backup from Queue**:
    ```js
    axios.post(`${backupServerUrl}/cancel-changes`, { minutes });
    ```

For a detailed example, see the `example/use_backup.js` folder.