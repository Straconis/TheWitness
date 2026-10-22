import {UserError} from "../errors";
import type {AudioEdits} from "./edits";

// Soundcraft MAX_IMPORT_SAMPLES (1<<30, crates/engine/src/io.rs; unchanged from 0.8 to 0.10.0) / two channels at 48 kHz.
// This is a per-source decoder ceiling, not a measurement of the user's free RAM.
export const SOUNDCRAFT_MAX_FRAMES=2**29;
export const SOUNDCRAFT_MAX_SECONDS=SOUNDCRAFT_MAX_FRAMES/48000;
export const SOUNDCRAFT_LENGTH_WARNING="Soundcraft is unavailable because this audio exceeds its length limit of about 3 hours, 6 minutes, 25 seconds per stereo track. Soundcraft loads audio directly into RAM. Export a shorter excerpt or choose another format. Silence trimming is not counted here, so a trimmed export can still be blocked.";
export const SOUNDCRAFT_UNKNOWN_WARNING="Soundcraft is unavailable because the recording length could not be verified. Soundcraft loads audio directly into RAM and limits stereo tracks to about 3 hours, 6 minutes, 25 seconds. Set an excerpt end time or choose another format.";
export const SOUNDCRAFT_RAM_NOTICE="Soundcraft loads all speaker tracks directly into RAM, about 1.3 GiB per speaker per hour of audio, plus a temporary copy of each file while it opens. Longer recordings and more speakers need more memory, even below its per-track length limit. Extract the ZIP, then open session.scraft.";

export interface RecordingLength {durationSamples?:number;audioOrigin?:number;startedAt?:string;endedAt?:string}
export function recordingSeconds(session:RecordingLength):number{
 if(typeof session.durationSamples==="number"&&Number.isFinite(session.durationSamples)&&session.durationSamples>=0)return Math.max(0,session.durationSamples-(session.audioOrigin??0))/48000;
 const elapsed=(Date.parse(session.endedAt??"")-Date.parse(session.startedAt??""))/1000;
 return Number.isFinite(elapsed)&&elapsed>=0?elapsed:NaN;
}
export function soundcraftWarning(seconds:number):string|undefined{
 if(!Number.isFinite(seconds)||seconds<0)return SOUNDCRAFT_UNKNOWN_WARNING;
 if(Math.round(seconds*48000)>SOUNDCRAFT_MAX_FRAMES)return SOUNDCRAFT_LENGTH_WARNING;
}
export function assertSoundcraftLength(seconds:number):void{
 const warning=soundcraftWarning(seconds);if(warning)throw new UserError(warning);
}
export function soundcraftExportSeconds(session:RecordingLength,options:{trimStart?:number;trimEnd?:number;edits?:AudioEdits},introSeconds=0):number{
 if(options.edits)return Math.max(...options.edits.tracks.map(track=>Math.max(...track.clips.map(clip=>clip.at+clip.end-clip.start))))+introSeconds;
 const duration=recordingSeconds(session),end=options.trimEnd===undefined?duration:Number.isFinite(duration)?Math.min(duration,options.trimEnd):options.trimEnd;
 return Math.max(0,end-(options.trimStart??0))+introSeconds;
}
