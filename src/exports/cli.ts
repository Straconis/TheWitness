import "dotenv/config";
import path from "node:path";
import { exportSession, ExportFormat } from "./export";
const [sessionID, format = "ogg", mode] = process.argv.slice(2);
if (!sessionID) {
  console.error("Usage: npm run export -- <session UUID> [ogg|wav|flac|mp3|audition] [--mix]");
  process.exitCode = 1;
} else {
  exportSession(path.resolve(process.env.RECORDING_PATH || "recordings"), sessionID, { format: format as ExportFormat, mix: mode === "--mix" })
    .then(directory => console.log(`Export saved: ${directory}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
