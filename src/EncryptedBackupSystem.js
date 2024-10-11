const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class EncryptedBackupSystem {
    constructor(backupDir, encryptionKey) {
        this.backupDir = backupDir;
        this.algorithm = 'aes-256-cbc';
        this.key = crypto.scryptSync(encryptionKey, 'salt', 32);
    }

    async encryptAndSave(data, filename) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
        let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const fileContent = JSON.stringify({ iv: iv.toString('hex'), encryptedData: encrypted });
        await fs.writeFile(path.join(this.backupDir, filename), fileContent);
    }

    async readAndDecrypt(filename) {
        const fileContent = await fs.readFile(path.join(this.backupDir, filename), 'utf8');
        const { iv, encryptedData } = JSON.parse(fileContent);

        const decipher = crypto.createDecipheriv(this.algorithm, this.key, Buffer.from(iv, 'hex'));
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return JSON.parse(decrypted);
    }

    async saveBackup(collection, backupData) {
        const filename = `${collection}_versions.enc`;
        await this.encryptAndSave(backupData, filename);
    }

    async getBackup(collection) {
        const filename = `${collection}_versions.enc`;
        return await this.readAndDecrypt(filename);
    }
}

module.exports = EncryptedBackupSystem;