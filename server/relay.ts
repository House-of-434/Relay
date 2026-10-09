// Entry point for the `relay` command (see cli.ts).
import { main } from "./cli.ts";
import { exitAfterFlush } from "./exit.ts";

main().then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
