const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');


//Use KeyManager in the future?

class KeyManager {
    constructor(keyDirectory) {
        this.keyDirectory = keyDirectory;
        this.currentKeyVersion = 0;
        this.keys = new Map();
    }

    async initialize() {
        await fs.mkdir(this.keyDirectory, { recursive: true });
        await this.loadKeys();
        if (this.keys.size === 0) {
            await this.rotateKey();
        }
    }

    async loadKeys() {
        const files = await fs.readdir(this.keyDirectory);
        for (const file of files) {
            if (file.startsWith('key_') && file.endsWith('.key')) {
                const version = parseInt(file.split('_')[1].split('.')[0]);
                const keyData = await fs.readFile(path.join(this.keyDirectory, file), 'utf8');
                this.keys.set(version, keyData);
                this.currentKeyVersion = Math.max(this.currentKeyVersion, version);
            }
        }
    }

    async rotateKey() {
        this.currentKeyVersion++;
        const newKey = crypto.randomBytes(32).toString('hex');
        await fs.writeFile(path.join(this.keyDirectory, `key_${this.currentKeyVersion}.key`), newKey);
        this.keys.set(this.currentKeyVersion, newKey);
        return this.currentKeyVersion;
    }

    getCurrentKey() {
        return {
            version: this.currentKeyVersion,
            key: this.keys.get(this.currentKeyVersion)
        };
    }

    getKey(version) {
        return this.keys.get(version);
    }
}
