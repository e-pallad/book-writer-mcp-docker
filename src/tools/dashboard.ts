import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { collectDashboard } from "../dashboard/collect";
import { renderDashboard } from "../dashboard/render";

export function registerDashboardTools(server: McpServer): void {
  server.tool(
    "book_dashboard",
    "Everything worth knowing about the state of the book at once: progress, chapter status, which characters appear in which chapters, how story order compares to chapter order, revision activity, continuity and style findings, and what is still outstanding before publishing. Returns structured data — use book_dashboard_export for a page to look at.",
    {
      sections: z
        .array(
          z.enum([
            "overview",
            "chapters",
            "presence",
            "timeline",
            "velocity",
            "scenes",
            "health",
            "readiness",
          ])
        )
        .optional()
        .describe("Limit the response to these sections (default: all of them)"),
    },
    async ({ sections }) => {
      const data = collectDashboard();

      const payload = sections?.length
        ? {
            generatedAt: data.generatedAt,
            ...Object.fromEntries(
              sections.map((section) => [section, (data as never)[section]])
            ),
            ...(data.notes.length ? { notes: data.notes } : {}),
          }
        : data;

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "book_dashboard_export",
    "Write the dashboard to a self-contained HTML page — no network, no build step — showing progress, the character presence map, story order against chapter order, chapter activity, manuscript health and publishing readiness.",
    {
      outputPath: z
        .string()
        .optional()
        .describe("Output file path (default: ./dashboard.html)"),
    },
    async ({ outputPath }) => {
      const data = collectDashboard();
      const html = renderDashboard(data);

      const outPath =
        outputPath ||
        path.join(process.env.BOOK_PROJECT_DIR || process.cwd(), "dashboard.html");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html, "utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Dashboard written.",
                outputPath: outPath,
                openWith: `file://${outPath}`,
                summary: {
                  words: data.overview.totalWords,
                  percentComplete: data.overview.percentComplete,
                  chapters: data.overview.chapterCount,
                  findings: data.health.filter((f) => f.severity !== "good").length,
                  outstandingBeforePublishing: data.readiness.filter(
                    (r) => r.state === "needed"
                  ).length,
                },
                ...(data.notes.length ? { notes: data.notes } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
