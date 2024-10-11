# MongoDB Versioned Backup Server
## App Overview

The backup app listens for all MongoDB changes and manages backups with a delay.

### Key Features:
- **Data Encryption**

- **Data Queuing**: 
    - Changes are queued for 1 hour before being saved.

- **Queue Persistence**:
    - Queued changes are saved every 5 minutes in a separate file to ensure nothing is lost.

- **Versioned Backup**:
    - Each document change creates a new version, storing the entire change history.
    - Backups are stored as an object where each key is a document ID, and the value is an array of versions for that document.
    - When retreiving data, by default latest modified/created version will return. Optionally you can add allVersions=true parameter and you will get the history of all changes

- **Deleted Data Handling**:
    - Deleted entries are marked `isDeleted: true` but never removed from backups.

- **Logs**:
    - All logs can be found in the `backup-server.log` file.

### Starting the Server:
1. The entry point is at `./src/index.js`.
2. The `DelayedVersionedBackup` class manages the server setup and accepts 4 parameters:
    - `MongodbUri` (string): The MongoDB connection URI.
    - `Path` (string): Path for storing backup files.
    - `Delay` (integer): The delay in minutes for saving queued data.
    - `Port` (integer): Port for server to use

### Remote Server Usage:

*TO DO*: Implement access control, e.g., with a secret key.

- **Get Data from Backup**:
   - Retrieve data with GET requests, and cancel queued backups with POST requests.

- **Cancel Saving Backup from Queue**:
    ```js
    axios.post(`${backupServerUrl}/cancel-changes`, { minutes });
    ```

For a detailed example, see the `example/use_backup.js` folder.