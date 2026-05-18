const path = require('node:path');

const { backupDatabase } = require('./db');
const { nowUtc8Iso } = require('./time');

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'apple-monitor.sqlite');
  const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
  const backupPath = await backupDatabase({
    dbPath,
    backupDir,
    now: nowUtc8Iso(),
  });
  process.stdout.write(`${backupPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
};
