import {readFile} from "node:fs/promises";
import type {SettingsStore} from "../storage/settings";
import {validateNotice} from "../storage/recording-notices";
import {getStartSound,startSoundPath,validateOggOpus,resolveDefaultStartSound} from "../exports/start-sound";
/** Owner authorization stays in the router; notice selection and file validation live here. */
export class RecordingNoticesAdmin {
 constructor(private root:string,private settings:SettingsStore){}
 private references(){const refs=new Map<string,{sourceGuildID:string;customID:string}>();for(const [guild,settings] of this.settings.all())for(const id of [settings.startSound?.customID,settings.endSound?.customID])if(id)refs.set(guild+":"+id,{sourceGuildID:guild,customID:id});for(const ref of this.settings.recordingNotices.references())refs.set(ref.sourceGuildID+":"+ref.customID,ref);return [...refs.values()];}
 async list(){const sounds=[];for(const ref of this.references()){const sound=await getStartSound(this.root,ref.sourceGuildID,ref.customID);if(sound)sounds.push({...ref,...sound});}return {defaults:this.settings.recordingNotices.defaults(this.settings.all()),sounds};}
 async save(which:unknown,value:unknown){if(which!=="start"&&which!=="end")throw Error("Choose start or end notice.");const choice=validateNotice(which,value);if(choice.mode==="custom"){if(!this.references().some(ref=>ref.sourceGuildID===choice.sourceGuildID&&ref.customID===choice.customID))throw Error("Choose an existing recording notice.");if(!await getStartSound(this.root,choice.sourceGuildID,choice.customID))throw Error("Configured recording notice is unavailable.");await validateOggOpus(startSoundPath(this.root,choice.sourceGuildID,choice.customID));}await this.settings.recordingNotices.update(which,choice);}
 async preview(which:unknown){if(which!=="start"&&which!=="end")throw Error("Choose start or end notice.");const selected=this.settings.recordingNotices.defaults(this.settings.all())[which];if(selected.needsSelection)throw Error("Choose a shared default first.");const choice=selected.choice;let file:string|undefined;if(choice.mode==="custom")file=startSoundPath(this.root,choice.sourceGuildID,choice.customID);else if(which==="start"&&choice.mode==="default")file=await resolveDefaultStartSound();if(!file)throw Error("Recording notice is off or unavailable.");await validateOggOpus(file);return readFile(file);}
}
