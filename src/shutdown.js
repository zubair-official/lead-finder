/**
 * Stopping the server without leaving a browser behind.
 *
 * A search owns a Chromium process for minutes at a time. The previous handler
 * closed the HTTP server and called process.exit, so the scrape's cleanup never
 * ran: Chromium was orphaned, the persistent profile kept its lock files, and
 * the run's sidecar said "running" forever.
 *
 * Every dependency is injected so the sequence can be tested without signals,
 * sockets or a real browser.
 */

/**
 * @param {object} deps
 * @param {() => Promise<void>} deps.closeServer      stop accepting connections
 * @param {() => object|null}   deps.getActiveJob     the run in progress, if any
 * @param {() => Promise<boolean>} deps.closeBrowser  close Chromium if it is open
 * @param {(code: number) => void} deps.exit
 * @param {object} deps.log
 * @param {number} [deps.graceMs]  hard deadline before exiting regardless
 */
export function createShutdown({ closeServer, getActiveJob, closeBrowser, exit, log, graceMs = 15_000 }) {
  let inProgress = false;

  return async function shutdown(signal) {
    if (inProgress) {
      // A second Ctrl-C means "I am not waiting" - honour it.
      log.warn(`${signal} again - exiting immediately.`);
      exit(1);
      return;
    }
    inProgress = true;
    log.info(`${signal} received, shutting down.`);

    // Never hang: whatever happens below, the process leaves by this deadline.
    const deadline = setTimeout(() => {
      log.warn(`Shutdown took longer than ${graceMs}ms - exiting anyway.`);
      exit(1);
    }, graceMs);
    deadline.unref?.();

    try {
      const job = getActiveJob?.() ?? null;
      if (job) {
        // Tell the scrape loop to stop at its next checkpoint, so it does not
        // start another listing while we are closing up.
        job.requestStop?.();
      }

      await Promise.resolve(closeServer()).catch((error) => {
        log.warn("could not close the HTTP server cleanly", { error: error.message });
      });

      const closed = await Promise.resolve(closeBrowser()).catch((error) => {
        log.warn("could not close the browser cleanly", { error: error.message });
        return false;
      });
      if (closed) log.info("Closed the browser that was still open.");

      if (job) {
        await Promise.resolve(job.markInterrupted?.()).catch((error) => {
          log.warn("could not record the interrupted run", { error: error.message });
        });
        log.info(`Recorded run ${job.id} as interrupted.`);
      }
    } finally {
      clearTimeout(deadline);
      exit(0);
    }
  };
}
