/** Estimate only the current timed audio pass; later passes have independent speeds. */
export function estimateStepRemaining(processed:number,total:number|undefined,elapsedMs:number):number|undefined{
 if(total===undefined||![processed,total,elapsedMs].every(Number.isFinite)||processed<=0||total<=0||elapsedMs<5000)return;
 return Math.max(0,Math.ceil((total-processed)*elapsedMs/1000/processed));
}
