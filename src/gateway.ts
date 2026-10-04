// Gateway mode: instead of advertising every tool, the server advertises two —
// book_tools (find a tool, read its signature) and book_call (run it) — plus a
// short list of pinned tools used on nearly every turn.
//
// Why: tools/list is sent to the model on every session whether or not a tool
// is ever used. With all tools advertised that is ~27k tokens before the first
// word is written. A gateway turns it into a few hundred, and the signature of
// a tool is paid for only when that tool is actually needed.
//
// Calls still go through the tool's own zod schema, so validation, defaults and
// error messages are identical to calling the tool directly.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CatalogEntry, ToolResult, ToolServer } from "./tools/tool-server";

/** Hot-path tools advertised natively in gateway mode unless overridden. */
export const DEFAULT_PINNED = [
  "book_chapter_list",
  "book_chapter_read",
  "book_chapter_update",
  "book_chapter_append",
  "book_style_get",
  "book_character_list",
];

const GATEWAY_NAMES = new Set(["book_tools", "book_call"]);

type Json = Record<string, unknown>;

function text(payload: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: payload }], ...(isError ? { isError } : {}) };
}

// One-line type for a JSON-schema node: enough for a model to build a call,
// far smaller than the schema itself.
function typeOf(node: Json): string {
  if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join("|");
  if (Array.isArray(node.anyOf)) return (node.anyOf as Json[]).map(typeOf).join("|");
  if (node.type === "array") return `${typeOf((node.items as Json) ?? {})}[]`;
  if (node.type === "object") {
    const props = (node.properties as Record<string, Json>) ?? {};
    const required = new Set((node.required as string[]) ?? []);
    const keys = Object.keys(props);
    if (keys.length === 0) return "object";
    return `{ ${keys.map((k) => `${k}${required.has(k) ? "" : "?"}: ${typeOf(props[k])}`).join(", ")} }`;
  }
  return String(node.type ?? "any");
}

// Typed loosely on purpose: inferring zod's own types here hits TS2589, the
// same trap tool-server.ts describes.
const toJsonSchema = zodToJsonSchema as unknown as (schema: unknown, options: Json) => Json;

export function signature(entry: CatalogEntry): string {
  const schema = toJsonSchema(z.object(entry.schema), { $refStrategy: "none" });
  const props = (schema.properties as Record<string, Json>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const lines = Object.entries(props).map(([key, node]) => {
    const note = typeof node.description === "string" ? `  // ${node.description}` : "";
    return `  ${key}${required.has(key) ? "" : "?"}: ${typeOf(node)}${note}`;
  });
  return `${entry.name} — ${entry.description}\n${lines.length ? lines.join("\n") : "  (no arguments)"}`;
}

function firstSentence(description: string): string {
  const match = description.match(/^.*?[.!?](\s|$)/s);
  return (match ? match[0] : description).trim();
}

function find(catalog: Map<string, CatalogEntry>, query: string): CatalogEntry[] {
  const words = query.toLowerCase().split(/[\s_]+/).filter(Boolean);
  if (words.length === 0) return [...catalog.values()];
  return [...catalog.values()].filter((e) => {
    const hay = `${e.name} ${e.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function addGateway(tools: ToolServer, catalog: Map<string, CatalogEntry>): void {
  const visible = () => [...catalog.values()].filter((e) => !GATEWAY_NAMES.has(e.name));

  tools.tool(
    "book_tools",
    `Find book-writing tools and read their signatures. This server has ${visible().length} tools; most are not listed up front. ` +
      "Pass `find` to search by words in the name or description (e.g. 'character', 'export epub', 'timeline'); " +
      "pass `describe` with tool names to get their arguments, then run one with book_call. Call with no arguments to list every tool.",
    {
      find: z.string().optional().describe("Words to look for in tool names and descriptions; omit to list all"),
      describe: z.array(z.string()).optional().describe("Tool names whose full signature you need"),
    },
    ({ find: query, describe }) => {
      if (describe?.length) {
        const out = describe.map((name) => {
          const entry = catalog.get(name);
          return entry ? signature(entry) : `${name} — no such tool; use book_tools with find to search`;
        });
        return text(out.join("\n\n"));
      }
      const matches = find(catalog, query ?? "").filter((e) => !GATEWAY_NAMES.has(e.name));
      if (matches.length === 0) return text(`No tool matches "${query}". Call book_tools with no arguments to list all.`);
      return text(matches.map((e) => `${e.name} — ${firstSentence(e.description)}`).join("\n"));
    }
  );

  tools.tool(
    "book_call",
    "Run any book tool by name with its arguments — use book_tools first to find the name and see the arguments. " +
      "Behaves exactly like calling the tool directly; a wrong argument returns the tool's signature so you can correct it.",
    {
      tool: z.string().describe("Tool name, e.g. book_character_add"),
      args: z.record(z.unknown()).optional().describe("The tool's arguments as an object"),
    },
    async ({ tool, args }) => {
      const entry = catalog.get(tool);
      if (!entry || GATEWAY_NAMES.has(tool)) {
        return text(`Unknown tool "${tool}". Use book_tools with find to search.`, true);
      }
      const parsed = z.object(entry.schema).safeParse(args ?? {});
      if (!parsed.success) {
        const problems = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(args)"}: ${i.message}`);
        return text(`Invalid arguments for ${tool}:\n${problems.join("\n")}\n\n${signature(entry)}`, true);
      }
      return entry.handler(parsed.data as never);
    }
  );
}
