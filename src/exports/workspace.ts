import {AsyncLocalStorage} from "node:async_hooks";
/** Scope disk checks to one export, including its nested audio tools. */
const checks=new AsyncLocalStorage<(bytes?:number)=>Promise<void>>();
export function withExportSpaceCheck<T>(check:(bytes?:number)=>Promise<void>,work:()=>Promise<T>):Promise<T>{return checks.run(check,work);}
export function checkExportSpace(bytes?:number):Promise<void>|undefined{return checks.getStore()?.(bytes);}

const progress=new AsyncLocalStorage<(seconds:number)=>void>();
export function withExportProgress<T>(report:(seconds:number)=>void,work:()=>Promise<T>):Promise<T>{return progress.run(report,work);}
export function exportProgressReporter():((seconds:number)=>void)|undefined{return progress.getStore();}
