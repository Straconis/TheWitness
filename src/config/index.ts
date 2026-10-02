import "dotenv/config";
import path from "node:path";

export interface WitnessConfig {
  discordToken: string;
  recordingPath: string;
  lowDiskWarningBytes:number;
  downloadPort?: number;
  downloadHost?: string;
  downloadPublicURL?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const downloadPort = process.env.DOWNLOAD_PORT?.trim();
if (downloadPort && (!/^\d+$/.test(downloadPort) || Number(downloadPort) < 1 || Number(downloadPort) > 65535)) throw new Error("DOWNLOAD_PORT must be between 1 and 65535.");
if (downloadPort && !process.env.DOWNLOAD_PUBLIC_URL?.trim()) throw new Error("DOWNLOAD_PUBLIC_URL is required when downloads are enabled.");

const warningGiB=Number(process.env.LOW_DISK_WARNING_GIB?.trim()||"1");
if(!Number.isFinite(warningGiB)||warningGiB<=0)throw new Error("LOW_DISK_WARNING_GIB must be a positive number.");

export const config: WitnessConfig = {
  lowDiskWarningBytes:warningGiB*1024**3,
  discordToken: requireEnv("DISCORD_TOKEN"),
  downloadPort: downloadPort ? Number(downloadPort) : undefined,
  downloadHost: process.env.DOWNLOAD_BIND_HOST?.trim() || "0.0.0.0",
  downloadPublicURL: process.env.DOWNLOAD_PUBLIC_URL?.trim(),
  recordingPath: path.resolve(
    process.cwd(),
    process.env.RECORDING_PATH?.trim() || "recordings"
  )
};
