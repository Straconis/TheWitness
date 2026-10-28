import {writeFile} from "node:fs/promises";
import path from "node:path";
import {projectSamples} from "./project-audio";
import {assertSoundcraftLength} from "./soundcraft-limits";

/** Soundcraft native JSON format v1, verified against its serialized Session model. */
export async function writeSoundcraft(directory:string,tracks:Array<{file:string;username:string}>,notes:Array<{seconds:number;text:string}>=[],title?:string,media=""):Promise<void>{
 if(media&&!/^[A-Za-z0-9_-]+\/$/.test(media))throw new Error("Invalid Soundcraft media folder.");
 if(!tracks.length)throw new Error("Soundcraft sessions need at least one audio track.");
 let nextID=1;const alloc=()=>nextID++;
 const sources=[],audio=[];
 for(const track of tracks){
  if(!/^[^/\\\x00-\x1f]+\.(wav|flac)$/.test(track.file))throw new Error("Invalid Soundcraft audio file.");
  const frames=await projectSamples(path.join(directory,track.file));assertSoundcraftLength(frames/48000);
  const source=alloc(),id=alloc(),clip=alloc();
  sources.push({id:source,name:track.username,path:media+track.file,channels:2,frames,sample_rate:48000,format:track.file.endsWith(".flac")?"Flac":"Wav",time_reference:0,unsaved:false});
  audio.push({id,name:track.username,kind:"Audio",format:"Stereo",color:[56,175,157],height:"Medium",active_playlist:0,
   playlists:[{name:track.username,clips:[{id:clip,name:track.username,start:0,length:frames,content:{Audio:{source,offset:0}}}]}],
   mixer:{volume_db:0,pan:[-1,1],mute:false,solo:false,input:"None",output:"Main",inserts:Array(10).fill(null),sends:Array(10).fill(null),automation_mode:"Read"},automation:[],view:"waveform"});
 }
 const end=Math.max(...sources.map(source=>source.frames));
 const markers=notes.filter(note=>Number.isFinite(note.seconds)&&note.seconds>=0&&Math.round(note.seconds*48000)<=end).map((note,index)=>({id:alloc(),number:index+1,name:note.text,kind:"Marker",start:Math.round(note.seconds*48000),end:Math.round(note.seconds*48000),comments:note.text}));
 const session={format_version:1,name:title||"The Witness recording",sample_rate:48000,bit_depth:"Int16",frame_rate:"Fps30",timecode_start:0,
  tempo:{tempos:[{tick:0,bpm:120}],meters:[{tick:0,numerator:4,denominator:4}]},tracks:audio,sources,busses:[],outputs:[{name:"Out 1-2",first_channel:0,format:"Stereo"}],markers,groups:[],next_id:nextID,
  edit:{tool:"Smart",edit_mode:"Slip",selection:{start:0,end:0},selected_tracks:[],playhead:0,grid:{Seconds:1},nudge:{Seconds:1},main_counter:"MinSecs",sub_counter:"Samples",
   zoom:{samples_per_px:Math.max(1024,end/1200),scroll:0,waveform_zoom:1,presets:[64,256,1024,4096,16384]},zoom_toggle:null,rulers:["min_secs","markers"],
   link_timeline_edit:true,link_track_edit:false,insertion_follows_playback:false,loop_playback:false,pre_post_roll:false,pre_roll:96000,post_roll:96000,tab_to_transient:false,
   automation_follows_edit:true,markers_follow_edit:false,layered_editing:false,mirrored_midi:false,click:false,countoff:false,countoff_bars:2,midi_merge:false,record_mode:"normal",loop_record:false,quickpunch:false,
   scrolling:"page",solo_mode:"sip",pre_fader_metering:false,delay_compensation:true,keyboard_focus:"commands",timeline_selection:{start:0,end:0}}};
 await writeFile(path.join(directory,"session.scraft"),JSON.stringify(session,null,2));
}
