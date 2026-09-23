const fs = require("fs");
const os = require("os");
const path = require("path");

// Each test gets its own project directory. filestore reads
// BOOK_PROJECT_DIR on every call rather than caching it, so setting the
// variable is enough to redirect a whole test at a fresh project.
function useTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-test-"));
  process.env.BOOK_PROJECT_DIR = dir;
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { useTempProject, cleanup };
