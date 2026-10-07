/** Preserve cleanup order, but attempt every stage even if an earlier stage fails. */
export async function shutdownInOrder(stages:Array<{name:string;close:()=>Promise<unknown>|unknown}>,report:(name:string,error:unknown)=>void):Promise<void>{
 for(const stage of stages){try{await stage.close();}catch(error){report(stage.name,error);}}
}
