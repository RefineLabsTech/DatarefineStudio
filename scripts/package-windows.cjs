#!/usr/bin/env node
/**
 * Tauri calls this from beforeBuildCommand. Windows builds create the
 * standalone Python engine and the read-only bundled resource tree. Non-
 * Windows frontend builds do not have a Windows PyInstaller artifact, so this
 * step intentionally becomes a no-op there.
 */
const { spawnSync } = require("child_process");
const path = require("path");

if (process.platform !== "win32") {
  console.log("[DataRefine] Windows packaging step skipped on non-Windows host.");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "package-windows.ps1")],
  { cwd: root, stdio: "inherit" },
);

if (result.error) {
  console.error(`[DataRefine] Could not start PowerShell: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
