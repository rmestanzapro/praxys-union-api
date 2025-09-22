const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info', // nivel configurable con env
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// Helpers
logger.errorWithCode = (message, code, metadata = {}) => {
  logger.error(message, { error_code: code, ...metadata });
};

logger.warnWithContext = (message, context = {}) => {
  logger.warn(message, context);
};

logger.infoWithContext = (message, context = {}) => {
  logger.info(message, context);
};

module.exports = logger;