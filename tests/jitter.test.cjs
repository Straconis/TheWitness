const test=require('node:test');
const assert=require('node:assert/strict');
const {PacketBuffer}=require('../dist/recording/jitter');
const packet=(timestamp,arrival=0n,userID='alice')=>({data:Buffer.from([1,2]),timestamp,arrival,userID,username:userID});

test('reorders within a bounded window, removes duplicates, and drops packets older than committed audio',()=>{
 const buffer=new PacketBuffer(3);
 assert.deepEqual(buffer.push(packet(200)),[]);
 assert.deepEqual(buffer.push(packet(100)),[]);
 assert.deepEqual(buffer.push(packet(100)),[]);
 assert.deepEqual(buffer.push(packet(300)).map(p=>p.timestamp),[100]);
 assert.deepEqual(buffer.push(packet(50)),[]);
 assert.deepEqual(buffer.flush().map(p=>p.timestamp),[200,300]);
 assert.deepEqual(buffer.stats,{duplicatesDropped:1,latePacketsDropped:1});
});
test('handles RTP timestamp wraparound and independent speaker timelines',()=>{
 const buffer=new PacketBuffer();
 buffer.push(packet(0xfffffff0)); buffer.push(packet(0x10)); buffer.push(packet(0xfffffff8));
 buffer.push(packet(0x5,0n,'bob'));
 assert.deepEqual(buffer.flush().map(p=>[p.userID,p.timestamp]),[['alice',0xfffffff0],['alice',0xfffffff8],['alice',0x10],['bob',5]]);
});
test('flushes a short burst after 200ms and allows a restarted stream after silence',()=>{
 const buffer=new PacketBuffer();
 buffer.push(packet(1000));
 assert.deepEqual(buffer.flushAged(9599n),[]);
 assert.deepEqual(buffer.flushAged(9600n).map(p=>p.timestamp),[1000]);
 buffer.push(packet(10,100000n));
 assert.deepEqual(buffer.flush().map(p=>p.timestamp),[10]);
});
test('enforces aggregate memory budget and retains buffered data for finalization',()=>{
 const buffer=new PacketBuffer(16,3);
 buffer.push(packet(1));
 assert.throws(()=>buffer.push(packet(2)),/memory budget/);
 assert.deepEqual(buffer.flush().map(p=>p.timestamp),[1]);
});
