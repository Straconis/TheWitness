/** Monotonic wall time between sequential export progress boundaries; never CPU time. */
export type ExportStageKind="prepare"|"synchronize"|"originals"|"conversion"|"cleanup"|"silence"|"loudness"|"intro"|"mix"|"project"|"packaging"|"transcription"|"upload"|"other";
export interface ExportStageTiming {wallMs:number;segments:number}
export type ExportStageProfile=Partial<Record<ExportStageKind,ExportStageTiming>>;
function category(id?:string):ExportStageKind{
 const prefix=id?.split(':')[0];
 if(prefix==='sync')return 'synchronize';if(prefix==='raw')return 'originals';
 if(['encode','edit'].includes(prefix??''))return 'conversion';if(prefix==='clean')return 'cleanup';
 if(['scan','cut'].includes(prefix??''))return 'silence';
 if(['level','intro-level','mix-level','mix-intro-level','mix-normalize'].includes(prefix??''))return 'loudness';
 if(['pad','intro'].includes(prefix??''))return 'intro';if(['mix','mix-combine'].includes(prefix??''))return 'mix';
 if(prefix==='aup3'||prefix==='project')return 'project';if(prefix==='package')return 'packaging';
 if(prefix==='transcription'||prefix==='upload')return prefix;
 return 'other';
}
export class ExportStageProfiler {
 readonly timings:ExportStageProfile={};private began:number;private current:ExportStageKind='prepare';private closed=false;
 constructor(private now:()=>number=()=>performance.now()){this.began=now();}
 begin(id?:string):void{if(this.closed)return;this.flush();this.current=category(id);}
 private flush():void{const end=this.now(),row=this.timings[this.current]??{wallMs:0,segments:0};row.wallMs+=Math.max(0,end-this.began);row.segments++;this.timings[this.current]=row;this.began=end;}
 finish():void{if(!this.closed){this.flush();this.closed=true;}}
}
