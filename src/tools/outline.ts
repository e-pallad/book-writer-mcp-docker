import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOutline, saveOutline } from "../storage/filestore";
import { BookMCPError } from "../utils/errors";
import { normalizeForCompare } from "../utils/text";

export function registerOutlineTools(server: McpServer): void {
  server.tool(
    "book_outline_set",
    "Set or replace the full hierarchical outline",
    {
      outline: z
        .array(
          z.object({
            act: z.string().optional().describe("Act name"),
            chapters: z.array(
              z.object({
                title: z.string().describe("Chapter title"),
                synopsis: z.string().describe("Chapter synopsis"),
                scenes: z.array(z.string()).optional().describe("Scene list"),
              })
            ),
          })
        )
        .describe("Hierarchical outline with acts and chapters"),
    },
    async ({ outline }) => {
      saveOutline({ acts: outline });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                message: "Outline saved.",
                actCount: outline.length,
                chapterCount: outline.reduce(
                  (sum, act) => sum + act.chapters.length,
                  0
                ),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "book_outline_get",
    "Retrieve the full outline",
    {},
    async () => {
      const outline = getOutline();
      if (!outline)
        throw new BookMCPError("No outline found. Run book_init first.");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(outline, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "book_outline_update_chapter",
    "Update synopsis or scenes for one chapter in the outline",
    {
      chapterTitle: z.string().describe("Chapter title to update"),
      synopsis: z.string().optional().describe("New synopsis"),
      scenes: z.array(z.string()).optional().describe("New scene list"),
    },
    async ({ chapterTitle, synopsis, scenes }) => {
      const outline = getOutline();
      if (!outline)
        throw new BookMCPError("No outline found. Run book_init first.");

      let found = false;
      for (const act of outline.acts) {
        for (const ch of act.chapters) {
          if (normalizeForCompare(ch.title) === normalizeForCompare(chapterTitle)) {
            if (synopsis !== undefined) ch.synopsis = synopsis;
            if (scenes !== undefined) ch.scenes = scenes;
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (!found)
        throw new BookMCPError(
          `Chapter "${chapterTitle}" not found in outline.`
        );

      saveOutline(outline);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { message: `Outline chapter "${chapterTitle}" updated.` },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
