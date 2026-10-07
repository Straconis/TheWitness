const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
test('operator log portal authenticates, stays read-only, restricts journal access and redacts sensitive messages',()=>{
 const result=spawnSync('python3',[path.resolve(__dirname,'log_portal_checks.py')],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stdout+result.stderr);
});
