import { commandReceipt, runCommand } from "./commands.ts";
import type { ReceiptStore } from "./scribe-monitor.ts";

/** Arm/notify receipts backed by the harness command-receipt store — the same
 * primitive the mailbox monitor uses. `record` is transactional and a receipt
 * already present short-circuits, so a restart never double-arms. */
export function commandReceipts(): ReceiptStore {
  return {
    has: (kind, key) => commandReceipt(kind, key) !== null,
    record: (kind, key, result) => {
      runCommand({ kind, key }, () => result);
    },
  };
}
