// Prepare deterministic public release metadata. Never includes profiles, keys, or user papers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const pkg = require("../package.json");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "build/addon/manifest.json"), "utf8"),
);
if (
  manifest.version !== pkg.version ||
  manifest.name !== pkg.config.addonName ||
  manifest.applications.zotero.id !== pkg.config.addonID
)
  throw new Error("Build manifest does not match package metadata");
const repository = "KiiiLin/zotero-fulltext-translate";
const filename = `${pkg.name}.xpi`;
const asset = fs.readFileSync(path.join(root, "build", filename));
const digest = crypto.createHash("sha256").update(asset).digest("hex");
const directory = path.join(root, "build/release");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, filename), asset);
const updates = {
  addons: {
    [pkg.config.addonID]: {
      updates: [
        {
          version: pkg.version,
          update_link: `https://github.com/${repository}/releases/download/v${pkg.version}/${filename}`,
          update_hash: `sha256:${digest}`,
          applications: {
            zotero: {
              strict_min_version:
                manifest.applications.zotero.strict_min_version,
              strict_max_version:
                manifest.applications.zotero.strict_max_version,
            },
          },
        },
      ],
    },
  },
};
fs.writeFileSync(
  path.join(directory, "update.json"),
  JSON.stringify(updates, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(directory, "SHA256SUMS"),
  `${digest}  ${filename}\n`,
);
console.log(
  `Prepared ${filename}, update.json and SHA256SUMS for v${pkg.version}`,
);
