import {readFile,readdir} from "node:fs/promises";
import type {SettingsStore} from "../storage/settings";
import {validateNotice} from "../storage/recording-notices";
import {getStartSound,startSoundPath,startSoundDirectory,validateOggOpus,resolveDefaultStartSound,uploadStartSoundChunk,noticeLibraryGuild} from "../exports/start-sound";
import {sessionIDPattern} from "../storage/sessions";
/** Owner authorization stays in the router; notice selection and file validation live here. */
export class RecordingNoticesAdmin {
 constructor(private root:string,private settings:SettingsStore){}
 private references(){const refs=new Map<string,{sourceGuildID:string;customID:string}>();for(const [guild,settings] of this.settings.all())for(const id of [settings.startSound?.customID,settings.endSound?.customID])if(id)refs.set(guild+":"+id,{sourceGuildID:guild,customID:id});for(const ref of this.settings.recordingNotices.references())refs.set(ref.sourceGuildID+":"+ref.customID,ref);return [...refs.values()];}
 private async library(){let files:string[]=[];try{files=await readdir(startSoundDirectory(this.root,noticeLibraryGuild));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}return files.filter(file=>file.endsWith(".json")&&sessionIDPattern.test(file.slice(0,-5))).map(file=>({sourceGuildID:noticeLibraryGuild,customID:file.slice(0,-5)}));}
 private async choices(){const refs=new Map(this.references().map(ref=>[ref.sourceGuildID+":"+ref.customID,ref]));for(const ref of await this.library())refs.set(ref.sourceGuildID+":"+ref.customID,ref);return [...refs.values()];}
 async list(){const sounds=[];for(const ref of await this.choices()){const sound=await getStartSound(this.root,ref.sourceGuildID,ref.customID);if(sound)sounds.push({...ref,...sound});}return {defaults:this.settings.recordingNotices.defaults(this.settings.all()),sounds};}
 async save(which:unknown,value:unknown){if(which!=="start"&&which!=="end")throw Error("Choose start or end notice.");const choice=validateNotice(which,value);if(choice.mode==="custom"){if(!(await this.choices()).some(ref=>ref.sourceGuildID===choice.sourceGuildID&&ref.customID===choice.customID))throw Error("Choose an existing recording notice.");if(!await getStartSound(this.root,choice.sourceGuildID,choice.customID))throw Error("Configured recording notice is unavailable.");await validateOggOpus(startSoundPath(this.root,choice.sourceGuildID,choice.customID));}await this.settings.recordingNotices.update(which,choice);}
 /** Uploads join the shared library; selecting one as a default is a separate save. */
 upload(data:unknown){return uploadStartSoundChunk(this.root,noticeLibraryGuild,data);}
 async preview(which:unknown){if(which!=="start"&&which!=="end")throw Error("Choose start or end notice.");const selected=this.settings.recordingNotices.defaults(this.settings.all())[which];if(selected.needsSelection)throw Error("Choose a shared default first.");const choice=selected.choice;let file:string|undefined;if(choice.mode==="custom")file=startSoundPath(this.root,choice.sourceGuildID,choice.customID);else if(which==="start"&&choice.mode==="default")file=await resolveDefaultStartSound();if(!file)throw Error("Recording notice is off or unavailable.");await validateOggOpus(file);return readFile(file);}
}
