import winston from 'winston';

const { combine, errors, timestamp, json } = winston.format;

export const logger = winston.createLogger({
    level: 'info',
    format: combine(
        errors({ stack: true }),
        timestamp(),
        json()
    ),
    transports: [
        new winston.transports.File({
            filename: 'application.log',
            options: { flags: 'a' }
        }),
        new winston.transports.Console()
    ]
});