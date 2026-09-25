import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Keep the existing local stdio client path available. HTTP authentication is
// intentionally not applied to stdio; the parent process is the trust boundary.
process.env.MCP_NO_HTTP = "1";
process.env.MCP_ALLOW_ANONYMOUS = "1";

const { createMcpServer } = await import("./server.mjs");
const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
