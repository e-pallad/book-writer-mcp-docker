const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// epubcheck is the reference implementation of the EPUB specification. It is a
// Java tool and far too large to vendor, so the suite uses it when it is
// present and says so when it is not, rather than quietly reporting a pass it
// did not earn.
//
// Point EPUBCHECK_JAR at epubcheck.jar to enable it:
//   curl -sSLo /tmp/epubcheck.zip \
//     https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip
//   unzip -q /tmp/epubcheck.zip -d /tmp
//   EPUBCHECK_JAR=/tmp/epubcheck-5.1.0/epubcheck.jar npm test
function locateEpubcheck() {
  const configured = process.env.EPUBCHECK_JAR;
  if (configured && fs.existsSync(configured)) return configured;

  for (const candidate of [
    "/tmp/epubcheck-5.1.0/epubcheck.jar",
    "/opt/epubcheck/epubcheck.jar",
    path.join(__dirname, "..", "..", "tools", "epubcheck", "epubcheck.jar"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function hasJava() {
  try {
    execFileSync("java", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs epubcheck over `epubPath`. Returns {available, output, ok}. When
 * epubcheck cannot be found the caller is expected to fall back to the
 * structural checks and report that the authoritative validator did not run.
 */
function runEpubcheck(epubPath) {
  const jar = locateEpubcheck();
  if (!jar || !hasJava()) {
    return { available: false, ok: false, output: "" };
  }

  try {
    const output = execFileSync("java", ["-jar", jar, epubPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { available: true, ok: true, output };
  } catch (error) {
    // epubcheck exits non-zero when it finds errors; its findings are on stderr.
    return {
      available: true,
      ok: false,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

module.exports = { runEpubcheck, locateEpubcheck };
