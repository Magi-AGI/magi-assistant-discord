import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config.js';
import { logger } from './logger.js';

let histogram: IntervalHistogram | null = null;
let diskCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start monitoring event loop lag and disk space.
 * Event loop lag is the critical health metric for an audio bot --
 * sustained lag >100ms means packets are being dropped.
 */
export function startMonitoring(): void {
  const config = getConfig();

  // Event loop delay monitoring (20ms resolution)
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  // Periodic check for event loop lag
  setInterval(() => {
    if (!histogram) return;
    const p99Ms = histogram.percentile(99) / 1e6; // nanoseconds -> ms
    if (p99Ms > config.eventLoopLagThresholdMs) {
      logger.warn(
        `Event loop lag: p99=${p99Ms.toFixed(1)}ms exceeds threshold ${config.eventLoopLagThresholdMs}ms -- audio packets may be dropping`
      );
    }
    histogram.reset();
  }, 10_000); // Check every 10 seconds

  // Periodic disk space check
  diskCheckInterval = setInterval(() => {
    checkDiskSpace(config);
  }, 60_000); // Check every 60 seconds

  // Initial disk check
  checkDiskSpace(config);

  logger.info('Monitoring started (event loop lag + disk space)');
}

function checkDiskSpace(config: ReturnType<typeof getConfig>): void {
  try {
    const dataDir = path.resolve(config.dataDir);
    // Ensure directory exists before checking
    if (!fs.existsSync(dataDir)) return;

    const stats = fs.statfsSync(dataDir);
    const freeMB = (stats.bfree * stats.bsize) / (1024 * 1024);

    if (freeMB < config.diskWarningThresholdMB) {
      logger.warn(
        `Disk space low: ${freeMB.toFixed(0)}MB free (threshold: ${config.diskWarningThresholdMB}MB)`
      );
    }
  } catch {
    // statfsSync may not be available on all platforms
  }
}

/** Get current event loop lag p99 in ms. */
export function getEventLoopLagMs(): number | null {
  if (!histogram) return null;
  return histogram.percentile(99) / 1e6;
}

/** Get free disk space in GB. */
export function getFreeDiskGB(): number | null {
  try {
    const config = getConfig();
    const stats = fs.statfsSync(path.resolve(config.dataDir));
    return (stats.bfree * stats.bsize) / (1024 * 1024 * 1024);
  } catch {
    return null;
  }
}

export function stopMonitoring(): void {
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
  if (diskCheckInterval) {
    clearInterval(diskCheckInterval);
    diskCheckInterval = null;
  }
}
