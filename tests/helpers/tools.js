// Tool handlers are registered against an McpServer, which is awkward to drive
// from a test. Every register*Tools() function only ever calls server.tool(),
// so a stub that records those calls is enough to get at the handlers — and it
// keeps the tests honest about the schema, since the recorded zod shape is what
// validates the input (defaults included) before the handler sees it.
const { z } = require("zod");

function collectTools(...registerFns) {
  const tools = {};
  const stubServer = {
    tool(name, description, schema, handler) {
      tools[name] = { name, description, schema, handler };
    },
  };
  for (const register of registerFns) register(stubServer);
  return tools;
}

async function callTool(tools, name, input = {}) {
  const tool = tools[name];
  if (!tool) {
    throw new Error(
      `No tool named "${name}". Registered: ${Object.keys(tools).join(", ")}`
    );
  }
  const parsed = z.object(tool.schema).parse(input);
  return tool.handler(parsed, {});
}

// Every tool in this server answers with a single JSON text block.
async function callJson(tools, name, input = {}) {
  const result = await callTool(tools, name, input);
  return JSON.parse(result.content[0].text);
}

module.exports = { collectTools, callTool, callJson };
