const { scanOnce } = require('./scanner');

function createScheduler({ config, repo, scanOnceImpl = scanOnce, logger = console, getConfig = null }) {
  let running = false;
  let timer = null;
  const intervalMs = Math.max(1, config.scheduler?.scanIntervalSeconds ?? 10) * 1000;

  async function runOnce(source = 'scheduled') {
    if (running) {
      logger.warn?.('scan skipped because a previous scan is still running');
      return { skipped: true };
    }

    running = true;
    try {
      const summary = await scanOnceImpl({
        config: getConfig ? getConfig() : config,
        repo,
        source,
      });
      logger.info?.(
        `scan completed: scanned=${summary.scannedOffers ?? 0} matched=${summary.matchedOffers ?? 0} alerts=${
          summary.alertsCreated ?? 0
        }`,
      );
      return { skipped: false, summary };
    } catch (error) {
      logger.error?.(`scan failed: ${error.stack || error.message}`);
      return { skipped: false, error };
    } finally {
      running = false;
    }
  }

  function start({ runImmediately = true } = {}) {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      runOnce('scheduled').catch((error) => logger.error?.(error.stack || error.message));
    }, intervalMs);
    timer.unref?.();

    if (runImmediately) {
      runOnce('startup').catch((error) => logger.error?.(error.stack || error.message));
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    runOnce,
    start,
    stop,
    get running() {
      return running;
    },
  };
}

module.exports = {
  createScheduler,
};
