// @ts-check
import sql from 'mssql';
import { logger } from './logger.js';
import 'dotenv/config';

const config = {
    user: process.env.DATABASE_USER || 'defaultUser',
    password: process.env.DATABASE_PASSWORD || 'defaultPassword',
    server: process.env.DATABASE_HOST || 'localhost',
    database: process.env.DATABASE_NAME || 'defaultDatabase',
    options: {
        encrypt: process.env.DATABASE_ENCRYPTION === 'true',
        trustServerCertificate: process.env.DATABASE_TRUST_SERVER_CERTIFICATE === 'true'
    }
};

async function connectToDatabase() {
    try {
        await sql.connect(config);
        logger.info("Connected to the database successfully");
        return sql;
    } catch (error) {
        logger.error('Error in connectToDatabase:', error);
        throw error;
    }
}

export { connectToDatabase, sql };