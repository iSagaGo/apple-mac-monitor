const { loadConfig } = require('./config');
const { createRepository, openDatabase } = require('./db');
const { createScheduler } = require('./scheduler');
const { createHttpServer, effectiveConfig } = require('./server');

function main() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repo = createRepository(db);
  const server = createHttpServer({ config, repo });
  const scheduler = config.scheduler.enabled
    ? createScheduler({ config, repo, getConfig: () => effectiveConfig(repo, config) })
    : null;

  server.listen(config.port, '0.0.0.0', () => {
    process.stdout.write(`apple mac monitor listening on http://0.0.0.0:${config.port}\n`);
    if (scheduler) {
      scheduler.start();
      process.stdout.write(`scheduler enabled: every ${config.scheduler.scanIntervalSeconds}s\n`);
    }
  });

  const shutdown = () => {
    scheduler?.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
