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

// Builds a fully configured server instance. Shared by every transport so the
// stdio and HTTP entry points always expose the same tools.
export function createServer(): McpServer {
  const server = new McpServer({
    name: "book-writer-mcp",
    version: "1.0.0",
  });

  // Register all tool modules
  registerManuscriptTools(server);
  registerProjectTools(server);
  registerConceptTools(server);
  registerHistoryTools(server);
  registerChapterEditTools(server);
  registerNoteTools(server);
  registerSceneTools(server);
  registerBookEditTools(server);
  registerStoryBibleTools(server);
  registerTimelineTools(server);
  registerResearchTools(server);
  registerOutlineTools(server);
  registerStructureTools(server);
  registerStyleGuideTools(server);
  registerRevisionTools(server);
  registerContinuityTools(server);
  registerExportTools(server);
  registerEpubTools(server);
  registerCoverTools(server);
  registerMetadataTools(server);
  registerMatterTools(server);
  registerAiDisclosureTools(server);
  registerAuthorTools(server);
  registerPreviewTools(server);
  registerDashboardTools(server);

  return server;
}
