const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boots the real HTTP entry point as a child process. The CORS behaviour under
// test is middleware ordering across the whole express app, so exercising the
// built server over a socket is the only way to prove it.
async function startHttpServer(env = {}) {
  const port = await freePort();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "book-mcp-http-"));
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "dist", "http-server.js")],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        BOOK_PROJECT_DIR: projectDir,
        MCP_AUTH_TOKEN: "test-static-token",
        MCP_OAUTH_PASSPHRASE: "test-passphrase",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${log}`);
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    port,
    projectDir,
    getLog: () => log,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startHttpServer, freePort };
