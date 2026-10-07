const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
test('audio tool cancellation waits for child close before allowing cleanup',async()=>{
 const cp=require('node:child_process'),original=cp.spawn;let closed=false,child;
 cp.spawn=(_exe,_args,options)=>{child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;options.signal.addEventListener('abort',()=>{child.emit('error',Error('aborted'));setTimeout(()=>{closed=true;child.emit('close',null,'SIGKILL');},40);},{once:true});return child;};
 try{delete require.cache[require.resolve('../dist/exports/process')];const {runTool}=require('../dist/exports/process'),controller=new AbortController();const result=runTool('fixture',[],controller.signal);controller.abort(Error('cancelled'));await assert.rejects(result,/cancelled/);assert.equal(closed,true,'child must be closed before the caller can remove its output');}
 finally{cp.spawn=original;}
});
