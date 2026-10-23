/* Run the pure full-text tests without starting Zotero or calling a provider. */
const { buildSync } = require("esbuild");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const directory = mkdtempSync(join(tmpdir(), "paragraph-tests-"));
try {
  buildSync({
    entryPoints: ["test/fulltext.node.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(directory, "tests.cjs"),
  });
  require(join(directory, "tests.cjs"));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
