import "dotenv/config";
import path from "node:path";

export interface WitnessConfig {
  discordToken: string;
  recordingPath: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config: WitnessConfig = {
  discordToken: requireEnv("DISCORD_TOKEN"),
  recordingPath: path.resolve(
    process.cwd(),
    process.env.RECORDING_PATH?.trim() || "recordings"
  )
};
