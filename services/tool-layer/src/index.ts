import { pathToFileURL } from "node:url";

import { createRelayToolServer } from "./http/server.js";
import { toolPort } from "./config.js";

export { createRelayToolServer } from "./http/server.js";
export { createAgentMcpServer } from "./mcp/agent-server.js";

async function main(): Promise<void> {
  const server = await createRelayToolServer();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : toolPort();
  console.log(`[relay-tools] listening on http://127.0.0.1:${port}`);

  const stop = () => {
    server.close((error) => {
      if (error) {
        console.error("[relay-tools] shutdown failed", error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[relay-tools] startup failed", error);
    process.exitCode = 1;
  });
}
