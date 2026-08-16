'use strict';

const { startServer } = require('../src/server');

async function main() {
  const durationMs = Math.max(5_000, Math.min(60_000, Number(process.argv[2] || 30_000)));
  const app = await startServer({ port: 0 });
  try {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const snapshot = app.engine.snapshot();
    const observation = snapshot.services.observationHealth || {};
    process.stdout.write(`${JSON.stringify({
      ok: true,
      durationMs,
      rpc: snapshot.services.rpc,
      rpcError: snapshot.services.rpcError || null,
      queueDepth: observation.queueDepth,
      activeFetches: observation.activeFetches,
      maxQueueSize: observation.maxQueueSize,
      rateLimits: observation.rpcRateLimited,
      backoffMs: observation.rpcBackoffMs,
      prefilteredNonSwap: observation.prefilteredNonSwap,
      failedFetches: observation.failedTransactionFetches,
      backfilled: observation.backfilledSignatures,
      droppedBackfill: observation.droppedBackfill,
      droppedLive: observation.droppedLive,
      auditEventsThisRun: snapshot.advanced.audit?.counts?.events || 0,
      memoryMb: Number(snapshot.advanced.memoryMb.toFixed(1)),
      snapshotBuildMs: snapshot.responseBuildMs
    })}\n`);
  } finally {
    app.server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => app.server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
}

main().then(() => process.exit(0)).catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exit(1); });
