import { workerConfig } from "./config.js";
import { createScribeWorkerServer } from "./http-server.js";
import { SessionController } from "./session.js";
import { diskFreeBytes, diskFreeBelow, maintainDiagnostics } from "./maintenance.js";

/** Retention + disk maintenance. Vexa writes failure screenshots to a hardcoded
 * path; the worker also owns /data/scribe/failures and /data/scribe/status. */
async function maintain(dataDir: string, probeDir: string, retentionMs: number, diskMinBytes: number): Promise<void> {
  const removed = await maintainDiagnostics(
    ["/app/storage/screenshots", `${dataDir}/failures`, `${dataDir}/status`, probeDir],
    retentionMs,
  );
  if (removed > 0) console.log(`[relay-scribe] retention: removed ${removed} expired file(s)`);
  try {
    const free = await diskFreeBytes(dataDir);
    if (diskFreeBelow(free, diskMinBytes)) {
      console.error(`[relay-scribe] LOW DISK: ${(free / 1_073_741_824).toFixed(2)} GiB free under ${dataDir}`);
    }
  } catch {
    /* statfs unavailable on this platform; skip the disk check */
  }
}

async function main(): Promise<void> {
  const config = workerConfig();
  const controller = new SessionController(config);
  const server = createScribeWorkerServer(controller, config);

  const maintenance = setInterval(
    () => void maintain(config.dataDir, config.probeDir, config.retentionMs, config.diskMinBytes),
    config.maintenanceMs,
  );
  maintenance.unref?.();
  void maintain(config.dataDir, config.probeDir, config.retentionMs, config.diskMinBytes);

  server.on("error", (error) => {
    console.error("[relay-scribe] fatal:", error);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`[relay-scribe] listening on http://${config.host}:${config.port} enabled=${config.enabled}`);
  });

  const stop = () => {
    clearInterval(maintenance);
    server.close(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error("[relay-scribe] startup failed", error);
  process.exit(1);
});
