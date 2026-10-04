// The one part of the MCP SDK's server the tool modules use: registering a
// tool. Declared here with plain zod types rather than taken from McpServer,
// whose signature infers each tool's arguments through a compatibility layer
// for zod 3 and zod 4 that TypeScript cannot finish — a single module took
// 140 seconds and 2.8 GB to check and still ended in TS2589. With this
// interface the tool modules type-check like any other code.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** What every tool here answers with: one or more text blocks. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolServer {
  tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => ToolResult | Promise<ToolResult>
  ): void;
}

// The SDK's own signature is exactly what cannot be type-checked, so the call
// goes through a plain function type. The SDK still validates every call
// against the zod shape at runtime, as before.
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodRawShape },
  handler: (args: never) => ToolResult | Promise<ToolResult>
) => unknown;

/** A tool as the modules declared it, kept so it can be listed or called later. */
export interface CatalogEntry {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: never) => ToolResult | Promise<ToolResult>;
}

/**
 * Registers tools on the server — or, for the names not in `listed`, only in
 * `catalog`, which the gateway tools (see ../gateway.ts) search and call.
 *
 * `listed` undefined means every tool is registered natively, which is how the
 * server has always behaved. A set means only those names are advertised in
 * tools/list; the rest cost the client nothing until it asks for them.
 */
export function toolServer(
  server: McpServer,
  options: { listed?: ReadonlySet<string>; catalog?: Map<string, CatalogEntry> } = {}
): ToolServer {
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  return {
    tool(name, description, schema, handler) {
      const h = handler as (args: never) => ToolResult;
      options.catalog?.set(name, { name, description, schema, handler: h });
      if (!options.listed || options.listed.has(name)) {
        register(name, { description, inputSchema: schema }, h);
      }
    },
  };
}
