import net from "node:net";
import process from "node:process";

import { loadConfig } from "./config.mjs";

const { config } = loadConfig();
const { host: listenHost, port: listenPort, targetHost, targetPort } = config.relay;

const relay = net.createServer((client) => {
  const upstream = net.createConnection({ host: targetHost, port: targetPort });
  client.pipe(upstream);
  upstream.pipe(client);
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});

relay.on("error", (error) => {
  console.error(`tcp-relay error: ${error.message}`);
  process.exitCode = 1;
});

relay.listen(listenPort, listenHost, () => {
  console.error(`tcp-relay listening on ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
});

function shutdown() {
  relay.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
