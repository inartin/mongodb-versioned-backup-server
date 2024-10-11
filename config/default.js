const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
module.exports = {
    primaryMongodbUri: process.env.MONGODB_URI,
    port: process.env.PORT || 3001,
    delayMinutes: process.env.DELAY_MINUTES || 60
};