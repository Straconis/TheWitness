/** Estimate only the current timed audio pass; later passes have independent speeds. */
export function estimateStepRemaining(processed:number,total:number|undefined,elapsedMs:number):number|undefined{
 if(total===undefined||![processed,total,elapsedMs].every(Number.isFinite)||processed<=0||total<=0||elapsedMs<5000)return;
 return Math.max(0,Math.ceil((total-processed)*elapsedMs/1000/processed));
}

export type ExportWorkKind="cleanup"|"sync"|"encode"|"analyze"|"normalize"|"measure"|"mix"|"package"|"project";
export interface ExportWork {id:string;kind:ExportWorkKind;seconds:number;passes?:number}
export interface OverallEstimate {remainingSeconds:number;minimumSeconds:number;maximumSeconds:number;updatedAt:string;provisional:boolean}
// Bootstrap ratios are deliberately broad. Actual observations replace each kind's rate.
const cost:Record<ExportWorkKind,number>={cleanup:4,sync:0.25,encode:1,analyze:1.25,normalize:8,measure:12,mix:1.5,package:0.1,project:0.5};

/** Sequential work ledger: completed operations never re-enter the remaining-work estimate. */
export class OverallExportProgress {
 private work:ExportWork[]=[];private index=-1;private began=0;private offset=0;private processed=0;
 private rates=new Map<ExportWorkKind,{seconds:number;wall:number}>();
 constructor(private now:()=>number=Date.now){}
 setPlan(work:ExportWork[]):void{this.work=work.filter(task=>Number.isFinite(task.seconds)&&task.seconds>=0).map(task=>({...task}));}
 begin(id:string,seconds?:number):void{
  const next=this.work.findIndex(task=>task.id===id);if(next<0||next===this.index)return;
  this.finishCurrent();this.index=next;this.began=this.now();this.offset=0;this.processed=0;
  if(seconds!==undefined&&Number.isFinite(seconds)&&seconds>=0)this.work[next]!.seconds=seconds;
 }
 progress(seconds:number):void{
  if(this.index<0||!Number.isFinite(seconds)||seconds<0)return;
  // FFmpeg restarts its clock for every pass inside an operation (measure/render/re-measure).
  if(seconds===0&&this.processed>0){this.offset+=this.processed;this.processed=0;}
  else this.processed=Math.max(this.processed,seconds);
 }
 private finishCurrent():void{
  const task=this.work[this.index];if(!task)return;
  const wall=(this.now()-this.began)/1000,seconds=this.offset+this.processed||task.seconds;
  if(wall>=0.05&&seconds>0){const old=this.rates.get(task.kind)??{seconds:0,wall:0};this.rates.set(task.kind,{seconds:old.seconds+seconds,wall:old.wall+wall});}
 }
 estimate():OverallEstimate|undefined{
  if(this.index<0)return;
  const task=this.work[this.index]!,elapsed=(this.now()-this.began)/1000,processed=this.offset+this.processed;
  const observed=new Map<ExportWorkKind,number>();
  for(const [kind,rate] of this.rates)if(rate.seconds>0&&rate.wall>0)observed.set(kind,rate.wall/rate.seconds);
  // A few seconds of the live pass can recalibrate the estimate before a long operation completes.
  if(elapsed>=5&&processed>0){const old=this.rates.get(task.kind)??{seconds:0,wall:0};observed.set(task.kind,(old.wall+elapsed)/(old.seconds+processed));}
  const base=observed.get("encode")??(observed.get("sync")!==undefined?observed.get("sync")!/cost.sync:undefined)??([...observed].length?[...observed][0]![1]/cost[[...observed][0]![0]]:undefined);
  if(base===undefined||!Number.isFinite(base)||base<=0)return;
  let remaining=0,unknown=0;
  for(let i=this.index;i<this.work.length;i++){
   const item=this.work[i]!,rate=observed.get(item.kind)??base*cost[item.kind];
   let units=item.seconds*(item.passes??1);
   if(i===this.index){
    if(processed>0)units=Math.max(0,units-processed);
    else units=Math.max(0,units-elapsed/rate);
   }
   const predicted=units*rate;remaining+=predicted;if(!observed.has(item.kind))unknown+=predicted;
  }
  // Keep an honest nonzero estimate while the final operation is still finishing.
  remaining=Math.max(5,remaining);const uncertainty=Math.min(1,unknown/remaining);
  return {remainingSeconds:Math.ceil(remaining),minimumSeconds:Math.max(5,Math.floor(remaining*(0.85-0.3*uncertainty))),maximumSeconds:Math.ceil(remaining*(1.25+1.25*uncertainty)),updatedAt:new Date(this.now()).toISOString(),provisional:uncertainty>0.2};
 }
}

export interface ExportPlanOptions {nativeAudacity?:boolean;includeRaw?:boolean;mix?:boolean;trimSilence?:boolean;trimEndSilence?:boolean;normalizeAudio?:boolean;cleanupAudio?:boolean;normalizeIntro?:boolean;trimStart?:number;trimEnd?:number;edits?:{tracks:Array<{track:number;clips:Array<{at:number;start:number;end:number}>}>}}
/** Plan the real operation order, including repeated loudness passes and optional mix/intro work. */
export function buildExportPlan(tracks:Array<{track:number;id?:string}>,source:number,clip:number,intro:number,format:string,options:ExportPlanOptions):ExportWork[]{
 const plan:ExportWork[]=[];const add=(id:string,kind:ExportWorkKind,seconds:number,passes=1)=>plan.push({id,kind,seconds,passes});
 for(const track of tracks){
  add(`sync:${track.track}`,"sync",source);
  if(options.includeRaw)add(`raw:${track.track}`,"encode",source);
  add(`encode:${track.track}`,"encode",format==="ogg"&&!options.trimStart&&options.trimEnd===undefined||format==="flac"&&options.includeRaw&&!options.trimStart&&options.trimEnd===undefined?0:clip);
  const edit=options.edits?.tracks.find(edit=>edit.track===track.track);if(edit)add(`edit:${track.track}`,"encode",Math.max(...edit.clips.map(c=>c.at+c.end-c.start)));
 }
 if(options.cleanupAudio)for(const t of tracks)if(t.id!=="witness-sync"){const edit=options.edits?.tracks.find(edit=>edit.track===t.track);add(`clean:${t.track}`,"cleanup",edit?Math.max(...edit.clips.map(c=>c.at+c.end-c.start)):clip);}
 const duration=options.edits?Math.max(...options.edits.tracks.map(t=>Math.max(...t.clips.map(c=>c.at+c.end-c.start)))):clip;
 if(options.trimSilence||options.trimEndSilence){for(const t of tracks)add(`scan:${t.track}`,"analyze",duration);for(const t of tracks)add(`cut:${t.track}`,"encode",duration);}
 if(options.normalizeAudio||intro&&options.normalizeIntro){for(const t of tracks)add(`level:${t.track}`,options.normalizeAudio?"normalize":"measure",duration,options.normalizeAudio?3:1);if(intro&&options.normalizeIntro)add("intro-level","measure",intro);}
 if(intro){for(const t of tracks)add(`pad:${t.track}`,"encode",duration+intro);add("intro","encode",intro);}
 if(options.mix){add("mix","mix",duration+intro);if(intro){if(options.normalizeIntro){add("mix-level","measure",duration+intro);add("mix-intro-level","measure",intro);}add("mix-combine","mix",duration+intro);}if(options.normalizeAudio)add("mix-normalize","normalize",duration+intro,3);}
 if(options.nativeAudacity)add("aup3","project",tracks.length*(duration+intro)+intro);
 add("package","package",tracks.length*duration+(options.includeRaw?tracks.length*source:0)+(options.mix?duration+intro:0)+intro);
 return plan;
}
