const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {summary}=require('../dist/exports/aup3-worker');
const fixture=(type,length)=>{const values=type==='int16'?new Int16Array(length):new Float32Array(length);let seed=42;for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values[i]=type==='int16'?(seed>>>16)-32768:(seed/2**32-.5)*2;}return values;};
const hash=result=>{const scalar=Buffer.alloc(24);scalar.writeDoubleLE(result.min);scalar.writeDoubleLE(result.max,8);scalar.writeDoubleLE(result.rms,16);return crypto.createHash('sha256').update(scalar).update(result.small).update(result.large).digest('hex');};
// Golden hashes include scalar statistics and both waveform resolutions from the original two-scan writer.
const golden={
 "int16:1": "4017d27a58d9a4c61dc9c8ac3e2f0e925a6a2813a7ad7b94026f0c1bf6d1f840",
 "int16:255": "36416ce22c50336fe66047a4af594769e03915b1023b3c580a8dcb2b9ca2f8fd",
 "int16:256": "f47aedbd87fca25daff0e01711f7da153e7b54c492dcf51e029fbb3200bd02ef",
 "int16:257": "1dc5dd03a1f1fe7f4e402e5dd192eddb60317dd40dd0212f87ee6940a03009f9",
 "int16:65535": "f5c0b573aafde65a2ee0c1becd088dd7ae7dadbefd7789ef47ef1d000cea211d",
 "int16:65536": "ec221c54f2ca9b7c04718aade8c66dbee9276e4f85b04be00a1bee029747c52e",
 "int16:65537": "d7c0732b6d3403c7760448a0dbb1d4d7b2a934605ffc9ab0e17bad34a11ee580",
 "int16:262144": "c0bb2d91c065c11ffe449404bfa77bb7ec67b9dead31373c611362b0df1b701c",
 "int16:524288": "4141c669604d05ab4fce2b9bb85f6fec1952e9b559d663672cab5dfb13dfc64b",
 "float:1": "29b3d04a24a32a36d15d7b5e21f81ca42dffb064b099fef882fc90450b0e53d2",
 "float:255": "510306c71a300b7bda18729a71ed28ec2aa66b8994dbed5165b10836876d6cbf",
 "float:256": "c523f768b12798a49c29300c8724fcecf9736d21c76bd32a912883094eb15035",
 "float:257": "ae5aa2acb0fa88f305398f27748f88dc4218512251595b98b0f13a05e361021f",
 "float:65535": "47848526a516d81e91728b3429be0a91a3dda2e51081de1466fd62a0eef9bea1",
 "float:65536": "7f39a48630483e5eb953ff4698f59115ea1cf21be199c13617e5c353d8c763ba",
 "float:65537": "b867a48759853444234ee0008d5fc5b1c8bfb20d5f29bef3e1116a426bae3548",
 "float:262144": "c0683aa6bc8fb2fd4605f72bc5af03b47213b333721fc2f57a8fe94f00751a56",
 "float:524288": "2cd0093a6ad2728cd7fe1d00a012dc1dcec14763ac920e3e6555a9722fb6b404"
};
test('native waveform statistics remain byte-identical at partial and full block boundaries',()=>{
 for(const [key,expected] of Object.entries(golden)){const [type,length]=key.split(':');assert.equal(hash(summary(fixture(type,Number(length)),type==='int16'?1/32768:1)),expected,key);}
});
