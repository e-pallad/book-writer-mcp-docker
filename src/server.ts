import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerManuscriptTools } from "./tools/manuscript";
import { registerStoryBibleTools } from "./tools/storybible";
import { registerOutlineTools } from "./tools/outline";
import { registerStyleGuideTools } from "./tools/styleguide";
import { registerContinuityTools } from "./tools/continuity";
import { registerExportTools } from "./tools/export";
import { registerEpubTools } from "./tools/epub";
import { registerCoverTools } from "./tools/cover";
import { registerAiDisclosureTools } from "./tools/ai-disclosure";
import { registerAuthorTools } from "./tools/author";
import { registerPreviewTools } from "./tools/preview";
import { registerDashboardTools } from "./tools/dashboard";
import { registerHistoryTools } from "./tools/history";
import { registerChapterEditTools } from "./tools/chapter-edit";
import { registerTimelineTools } from "./tools/timeline";
import { registerProjectTools } from "./tools/project";
import { registerBookEditTools } from "./tools/book-edit";
import { registerMetadataTools } from "./tools/metadata";
import { registerMatterTools } from "./tools/matter";
import { registerNoteTools } from "./tools/notes";
import { registerSceneTools } from "./tools/scenes";
import { registerConceptTools } from "./tools/concept";
import { registerStructureTools } from "./tools/structure";
import { registerRevisionTools } from "./tools/revision";
import { registerResearchTools } from "./tools/research";
import { CatalogEntry, toolServer } from "./tools/tool-server";
import { DEFAULT_PINNED, addGateway } from "./gateway";

// BOOK_MCP_TOOLS=gateway advertises two tools (book_tools, book_call) plus a
// pinned few instead of all of them, cutting the tokens spent on tools/list.
// Anything else (the default) advertises every tool, as before.
// BOOK_MCP_PINNED overrides which tools stay directly listed in gateway mode.
export interface ServerOptions {
  mode?: "full" | "gateway";
  pinned?: string[];
}

function optionsFromEnv(): ServerOptions {
  const pinned = process.env.BOOK_MCP_PINNED;
  return {
    mode: process.env.BOOK_MCP_TOOLS === "gateway" ? "gateway" : "full",
    pinned: pinned === undefined ? undefined : pinned.split(",").map((n) => n.trim()).filter(Boolean),
  };
}

// Builds a fully configured server instance. Shared by every transport so the
// stdio and HTTP entry points always expose the same tools.
export function createServer(options: ServerOptions = optionsFromEnv()): McpServer {
  const server = new McpServer({
    name: "book-writer-mcp",
    version: "1.0.0",
  });

  // Register all tool modules
  const gateway = options.mode === "gateway";
  const catalog = new Map<string, CatalogEntry>();
  const tools = toolServer(server, {
    catalog: gateway ? catalog : undefined,
    listed: gateway ? new Set(options.pinned ?? DEFAULT_PINNED) : undefined,
  });
  registerManuscriptTools(tools);
  registerProjectTools(tools);
  registerConceptTools(tools);
  registerHistoryTools(tools);
  registerChapterEditTools(tools);
  registerNoteTools(tools);
  registerSceneTools(tools);
  registerBookEditTools(tools);
  registerStoryBibleTools(tools);
  registerTimelineTools(tools);
  registerResearchTools(tools);
  registerOutlineTools(tools);
  registerStructureTools(tools);
  registerStyleGuideTools(tools);
  registerRevisionTools(tools);
  registerContinuityTools(tools);
  registerExportTools(tools);
  registerEpubTools(tools);
  registerCoverTools(tools);
  registerMetadataTools(tools);
  registerMatterTools(tools);
  registerAiDisclosureTools(tools);
  registerAuthorTools(tools);
  registerPreviewTools(tools);
  registerDashboardTools(tools);

  if (gateway) {
    // Registered through a plain (all-listed) ToolServer: these are the tools
    // the client does see.
    addGateway(toolServer(server, { catalog }), catalog);
  }

  return server;
}
