// One-time chess.com login for the live-board bridge.
// Opens a real (visible) Brave window on the bridge's browser profile.
// Log in to chess.com yourself, then simply close the window.
// The session cookie stays in data/brave-profile and the server's headless
// bridge will use it to watch live games. Credentials are never seen or
// stored by this app.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BRAVE_PATHS, launchBrowser } from "../lib/cdp.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileDir = path.join(root, "data", "brave-profile");
fs.mkdirSync(profileDir, { recursive: true });

const binary = BRAVE_PATHS.find((p) => fs.existsSync(p));
if (!binary) {
  console.error("No Brave/Chrome/Chromium found. Install one and retry.");
  process.exit(1);
}

console.log("Opening a browser window on the bridge profile.");
console.log("→ Log in to chess.com in that window, then close it.");
console.log("→ Afterwards, restart the exchange server: live chess.com markets get real-time boards.");

const { proc } = launchBrowser({
  binary,
  profileDir,
  headless: false,
  startUrl: "https://www.chess.com/login",
});
proc.on("exit", () => {
  console.log("Browser closed. If you logged in, you're all set — restart the server.");
  process.exit(0);
});
