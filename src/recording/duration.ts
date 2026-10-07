export const RECORDING_DURATION_HOURS = [2,4,6,8,12,16,24] as const;
export const DEFAULT_RECORDING_DURATION_HOURS = 8;
export const DURATION_WARNING_MINUTES = [60,30,15,5,1] as const;
export function validateRecordingDuration(value:unknown):number {
 if(typeof value!=="number" || !RECORDING_DURATION_HOURS.includes(value as typeof RECORDING_DURATION_HOURS[number]))throw new Error("Recording maximum must be 2, 4, 6, 8, 12, 16, or 24 hours.");
 return value;
}
