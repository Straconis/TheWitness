const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),path=require('node:path');
test('audio sources retry transient failures, reuse verified cache, and reject checksum mismatches',()=>{
 const result=spawnSync('python3',['-I','-c',`
import hashlib,io,json,pathlib,runpy,shutil,sys,tempfile,urllib.error
from unittest.mock import patch
with tempfile.TemporaryDirectory() as tmp:
 root=pathlib.Path(tmp);(root/'scripts').mkdir();(root/'licenses/audio').mkdir(parents=True)
 script=root/'scripts/prepare-audio-sources.py';shutil.copyfile(sys.argv[1],script)
 payload=b'checksum-pinned audio source'
 (root/'licenses/audio/sources.json').write_text(json.dumps({'source.bin':{'url':'https://example.invalid/source.bin','sha256':hashlib.sha256(payload).hexdigest()}}))
 with patch('urllib.request.urlopen',side_effect=[urllib.error.URLError('temporary timeout'),io.BytesIO(payload)]) as fetch,patch('time.sleep') as sleep:
  runpy.run_path(str(script));assert fetch.call_count==2;assert fetch.call_args.kwargs['timeout']==30;sleep.assert_called_once_with(2)
 with patch('urllib.request.urlopen') as fetch:
  runpy.run_path(str(script));fetch.assert_not_called()
 cached=root/'work/portable/sources/source.bin';cached.unlink()
 bundled=root/'licenses/audio/source.bin';bundled.write_bytes(payload)
 with patch('urllib.request.urlopen') as fetch:
  runpy.run_path(str(script));fetch.assert_not_called();assert cached.read_bytes()==payload
 cached.unlink();bundled.unlink()
 with patch('urllib.request.urlopen',side_effect=urllib.error.URLError('offline')) as fetch,patch('time.sleep'):
  try:runpy.run_path(str(script))
  except urllib.error.URLError:pass
  else:raise AssertionError('Expected exhausted download to fail')
  assert fetch.call_count==4;assert not cached.exists()
 with patch('urllib.request.urlopen',return_value=io.BytesIO(b'wrong archive')):
  try:runpy.run_path(str(script))
  except RuntimeError as error:assert 'checksum mismatch' in str(error)
  else:raise AssertionError('Expected a checksum mismatch to fail')
`,path.resolve(__dirname,'../scripts/prepare-audio-sources.py')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
});
