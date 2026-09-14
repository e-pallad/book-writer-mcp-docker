import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerManuscriptTools } from "./tools/manuscript";
import { registerStoryBibleTools } from "./tools/storybible";
import { registerOutlineTools } from "./tools/outline";
import { registerStyleGuideTools } from "./tools/styleguide";
import { registerContinuityTools } from "./tools/continuity";
import { registerExportTools } from "./tools/export";
import { registerCoverTools } from "./tools/cover";
import { registerAuthorTools } from "./tools/author";
import { registerPreviewTools } from "./tools/preview";

// Builds a fully configured server instance. Shared by every transport so the
// stdio and HTTP entry points always expose the same tools.
export function createServer(): McpServer {
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
  registerAuthorTools(server);
  registerPreviewTools(server);

  return server;
}
