const { execSync } = require("child_process");
const path = require("path");

if (process.platform !== "win32") {
  try {
    execSync("chmod +x " + path.join(__dirname, "bin", "llmcli"), { stdio: "inherit" });
  } catch { /* ignore */ }
}
