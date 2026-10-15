import { createApp } from './app.js';
import { ConfigError, deploymentWarnings, loadConfig, loadDotEnv } from './config.js';
import { DatabaseInitError, initializeDatabase } from './db/database.js';
import { createSongRequestRepository } from './db/requestRepository.js';
import { createSessionRepository } from './db/sessionRepository.js';
import { consoleLogger as logger } from './logger.js';
import { WEB_DIST_DIR } from './paths.js';

function main(): void {
  loadDotEnv();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  config.webDistDir = WEB_DIST_DIR;
  for (const warning of deploymentWarnings(config)) logger.warn(warning);

  let database;
  try {
    database = initializeDatabase(config.databasePath, logger);
  } catch (err) {
    if (err instanceof DatabaseInitError) {
      logger.error(`Database error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const repo = createSongRequestRepository(database.db);
  const sessions = createSessionRepository(database.db);
  const app = createApp({ config, repo, sessions, logger });

  const onListening = (): void => {
    logger.info('server listening', { host: config.host ?? 'all interfaces', port: config.port, env: config.nodeEnv });
  };
  const server = config.host ? app.listen(config.port, config.host, onListening) : app.listen(config.port, onListening);

  const shutdown = (): void => {
    logger.info('shutting down');
    server.close(() => {
      database.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
