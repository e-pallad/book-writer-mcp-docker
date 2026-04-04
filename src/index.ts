import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerManuscriptTools } from "./tools/manuscript";
import { registerStoryBibleTools } from "./tools/storybible";
import { registerOutlineTools } from "./tools/outline";
import { registerStyleGuideTools } from "./tools/styleguide";
import { registerContinuityTools } from "./tools/continuity";
import { registerExportTools } from "./tools/export";
import { registerCoverTools } from "./tools/cover";

const server = new McpServer({
  name: "book-writer-mcp",
  version: "1.0.0",
});

// Register all tool modules
registerManuscriptTools(server);
registerStoryBibleTools(server);
registerOutlineTools(server);
registerStyleGuideTools(server);
registerContinuityTools(server);
registerExportTools(server);
registerCoverTools(server);

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});
