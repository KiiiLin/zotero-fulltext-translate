// Exercise the real reader, menus, native note serialization, and a fresh recipient profile.
// This uses two disposable libraries and mocked translation; it never signs in or syncs online.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const pkg = require("../package.json");
const { config } = pkg;
const binary = process.argv[2] || process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH;
if (!binary)
  throw new Error(
    "Usage: node scripts/test-fulltext-zotero.cjs /path/to/zotero",
  );
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, ".scaffold"), { recursive: true });
const base = fs.mkdtempSync(path.join(root, ".scaffold/fulltext-runtime-"));
fs.copyFileSync(
  path.join(root, "test/fixtures/paragraphs.pdf"),
  path.join(base, "fixture.pdf"),
);
fs.copyFileSync(
  path.join(root, "build/zotero-fulltext-translate.xpi"),
  path.join(base, "package.xpi"),
);
async function run(phase) {
  const addonPath = path.join(base, "addon-" + phase);
  fs.cpSync(path.join(root, "build/addon"), addonPath, { recursive: true });
  fs.mkdirSync(path.join(base, "profile-" + phase, "extensions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(base, "data-" + phase));
  const prefs = {
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 5,
    "extensions.update.enabled": false,
    "app.update.enabled": false,
    "extensions.zotero.firstRun.skipFirefoxProfileAccessCheck": true,
    "extensions.zotero.firstRunGuidance": false,
    "extensions.zotero.firstRun2": false,
    "extensions.zotero.sync.autoSync": false,
    "extensions.zotero.automaticScraperUpdates": false,
    "extensions.zotero.httpServer.enabled": false,
    "extensions.zoteroOpenOfficeIntegration.skipInstallation": true,
    "extensions.zoteroWinWordIntegration.skipInstallation": true,
    "extensions.zoteroMacWordIntegration.skipInstallation": true,
    [`${config.prefsPrefix}.translateSource`]:
      phase === 1 ? "google" : "not-configured-on-recipient",
    [`${config.prefsPrefix}.targetLanguage`]: "zh-CN",
    [`${config.prefsPrefix}.fulltext.delay`]: 250,
  };
  fs.writeFileSync(
    path.join(base, "profile-" + phase, "user.js"),
    Object.entries(prefs)
      .map(
        ([key, value]) =>
          `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`,
      )
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(base, "profile-" + phase, "extensions", config.addonID),
    addonPath,
  );
  const driverURL = pathToFileURL(
    path.join(root, "test/fulltext-zotero-driver.js"),
  ).href;
  fs.appendFileSync(
    path.join(addonPath, "bootstrap.js"),
    `\nvar originalTestStartup = startup;
startup = async function(...args) {
 await originalTestStartup(...args);
 let qa = {Zotero,Services,IOUtils,Ci,__fulltextTestBase:${JSON.stringify(base)},__fulltextTestPhase:${phase},__fulltextTestVersion:${JSON.stringify(pkg.version)}};
 Services.scriptloader.loadSubScript(${JSON.stringify(driverURL)},qa);
 qa.startup();
};\n`,
  );
  const log = fs.openSync(path.join(base, "zotero-" + phase + ".log"), "w");
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.resolve(binary),
      [
        "--headless",
        "--no-remote",
        "--profile",
        path.join(base, "profile-" + phase),
        "--dataDir",
        path.join(base, "data-" + phase),
        "-ZoteroDebugText",
      ],
      {
        env: {
          ...process.env,
          MOZ_HEADLESS: "1",
          XDG_CACHE_HOME: path.join(base, "cache-" + phase),
        },
        stdio: ["ignore", log, log],
        detached: process.platform !== "win32",
      },
    );
    const timer = setTimeout(() => {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }, 150000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      fs.closeSync(log);
      resolve();
    });
  });
  const result = JSON.parse(
    fs.readFileSync(path.join(base, "result-" + phase + ".json"), "utf8"),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) throw new Error("Integration test failed in phase " + phase);
}
(async () => {
  try {
    await run(1);
    await run(2);
  } finally {
    console.log("Isolated test artifacts:", base);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
