#!/usr/bin/env python3
"""Bounded, offline audio-project import. Never opens paths supplied by a project.

Audacity binary XML follows ProjectSerializer.cpp at Audacity-3.7.9.
Session files describe audio and static placement; unsupported processing is rejected.
"""
import sys, os, json, math, pathlib, zipfile, stat, shutil, struct, sqlite3, subprocess, xml.etree.ElementTree as ET, urllib.parse
MAX_BYTES=32*1024**3
MAX_SECONDS=86400
AUDIO={'.wav','.flac','.ogg','.mp3','.m4a','.aac','.opus'}
PROJECT={'.sesx','.scraft','.aup3'}
class ImportError(ValueError): pass

def number(value, default=None):
    try: n=float(value)
    except (TypeError,ValueError):
        if default is not None:return default
        raise ImportError('Invalid numeric value in project.')
    if not math.isfinite(n):raise ImportError('Project contains a non-finite value.')
    return n

def bounded(value, low=0, high=MAX_SECONDS):
    n=number(value)
    if not low<=n<=high:raise ImportError('Project timing or level is outside the supported range (24 hours).')
    return n

def truth(value):return str(value).lower() in ('true','1')

def xml(data):
    if len(data)>32*1024**2:raise ImportError('Session metadata is too large.')
    if b'<!ENTITY' in data.upper() or b' SYSTEM ' in data.upper() or b' PUBLIC ' in data.upper():raise ImportError('External XML references are not supported.')
    root=ET.fromstring(data)
    if sum(1 for _ in root.iter())>250000:raise ImportError('Session metadata has too many elements.')
    for node in root.iter():node.tag=node.tag.split('}')[-1]
    return root

def normalized(name):
    return '/'.join(p for p in str(name).replace('\\','/').split('/') if p not in ('','.'))

class Recovery:
    def __init__(self, request, output, ffmpeg):
        self.request=request;self.output=pathlib.Path(output);self.ffmpeg=ffmpeg
        self.work=self.output/'work';self.work.mkdir(parents=True)
        self.files={};self.warnings=[];self.serial=0;self.notes=[]
    def progress(self,text):print(json.dumps({'stage':text}),flush=True)
    def space(self,extra=0):
        reserve=int(self.request.get('reserveBytes',1024**3))
        if shutil.disk_usage(self.output).free<reserve+extra:raise ImportError('Not enough free storage to import this project while preserving the recording reserve. Remove an unwanted upload or recording, then retry.')
    def temp(self,suffix):
        self.serial+=1;return self.work/(str(self.serial)+suffix)
    def run(self,args):
        self.space()
        with self.temp('.log').open('wb+') as log:
            child=subprocess.run([self.ffmpeg,'-nostdin','-v','error','-n',*map(str,args)],stdout=subprocess.DEVNULL,stderr=log,timeout=24*3600)
            if child.returncode:
                # Paths and decoder details stay in the server log, not the browser.
                log.seek(max(0,log.tell()-4096));print(log.read().decode(errors='replace'),file=sys.stderr)
                raise ImportError('An audio file could not be decoded. Check that the project media is complete and opens in its original application.')
    def add(self,name,file):
        name=normalized(name)
        if name in self.files:raise ImportError('Duplicate uploaded path: '+name)
        self.files[name]=pathlib.Path(file)
    def uploads(self):
        expanded=0;count=0
        for item in self.request['files']:
            file=pathlib.Path(item['path']);name=item['name'];ext=pathlib.Path(name).suffix.lower()
            if ext in ('.zip','.scraftz'):
                self.progress('Unpacking '+pathlib.PurePosixPath(name).name)
                with zipfile.ZipFile(file) as archive:
                    members=archive.infolist()
                    if len(members)>10000:raise ImportError('Archive has too many files.')
                    for member in members:
                        if member.is_dir():continue
                        relative=member.filename.replace('\\','/')
                        if relative.startswith('/') or ':' in relative or '..' in relative.split('/') or stat.S_ISLNK(member.external_attr>>16):raise ImportError('Archive contains an unsafe path or symbolic link.')
                        if member.flag_bits&1:raise ImportError('Encrypted archives are not supported.')
                        if pathlib.Path(relative).suffix.lower() not in AUDIO|PROJECT:continue
                        expanded+=member.file_size;count+=1
                        if expanded>MAX_BYTES or count>1000:raise ImportError('Expanded archive exceeds the 32 GiB / 1,000-file limit.')
                        self.space(member.file_size)
                        target=self.temp(pathlib.Path(relative).suffix.lower())
                        with archive.open(member) as src,target.open('xb') as dst:
                            copied=0
                            while True:
                                data=src.read(1024**2)
                                if not data:break
                                copied+=len(data)
                                if copied>member.file_size:raise ImportError('Archive member exceeds its declared size.')
                                self.space(len(data));dst.write(data)
                        self.add(relative,target)
            elif ext in AUDIO|PROJECT:self.add(name,file)
            else:raise ImportError('Unsupported file. Upload audio, .sesx, .scraft, .aup3, or a ZIP bundle.')
    def resolve(self,reference,project):
        ref=normalized(reference);relative=normalized(str(pathlib.PurePosixPath(project).parent)+'/'+ref)
        for key in (relative,ref):
            if key in self.files:return self.files[key]
        matches=[v for k,v in self.files.items() if k.endswith('/'+ref) or pathlib.PurePosixPath(k).name==pathlib.PurePosixPath(ref).name]
        if len(matches)==1:return matches[0]
        if len(matches)>1:raise ImportError('Ambiguous media filename: '+pathlib.PurePosixPath(ref).name+'. Keep folder paths or rename duplicates in the source project.')
        raise ImportError('Missing media: '+pathlib.PurePosixPath(ref).name+'. Upload the project’s audio files as well as its session file.')
    def clip(self,file,at=0,offset=0,length=None,gain=0,fade_in=0,fade_out=0):
        at=bounded(at);offset=bounded(offset);gain=bounded(gain,-120,60)
        if length is not None:
            length=bounded(length)
            if length<=0 or at+length>MAX_SECONDS:raise ImportError('Invalid clip length or timeline longer than 24 hours.')
        return dict(file=file,at=at,offset=offset,length=length,gain=gain,fade_in=bounded(fade_in),fade_out=bounded(fade_out))
    def audition(self,name):
        root=xml(self.files[name].read_bytes());session=root.find('session')
        if root.tag!='sesx' or session is None:raise ImportError('Invalid Audition session.')
        rate=bounded(session.get('sampleRate'),1,384000)
        files={f.get('id'):self.resolve(f.get('relativePath') or f.get('absolutePath') or '',name) for f in root.findall('./files/file')}
        tracks=[]
        if any(n.tag.lower() in ('effect','automationlane') and (len(n) or n.attrib) for n in session.iter()):raise ImportError('Audition effects or automation require rendered stems.')
        for track in session.findall('./tracks/audioTrack'):
            if any(n.tag.lower() in ('effect','automationlane','envelope') and (len(n) or n.attrib) for n in track.iter()):raise ImportError('Audition effects or automation require rendered stems. Export stems from Audition, then recover the audio files without a session.')
            params=track.find('trackAudioParameters');gain=0;pan=0
            if params is not None:
                if params.find('volume') is not None:gain=20*math.log10(max(1e-6,number(params.find('volume').get('value',1))))
                if params.find('pan') is not None:pan=bounded(params.find('pan').get('value',0),-1,1)
            clips=[]
            for node in track.findall('audioClip'):
                if truth(node.get('looped',False)) or number(node.get('stretchRatio',1))!=1:raise ImportError('Looped or stretched Audition clips need rendered stems.')
                file=files.get(node.get('fileID'))
                if not file:raise ImportError('Audition clip refers to missing media.')
                start=number(node.get('startPoint',0))/rate;end=number(node.get('endPoint',0))/rate;offset=number(node.get('sourceInPoint',0))/rate
                if any(n.tag.lower() in ('fadein','fadeout','clipenvelope') for n in node.iter()):raise ImportError('Audition clip fades/envelopes need rendered stems in this version.')
                clips.append(self.clip(file,start,offset,end-start))
            if clips:tracks.append(dict(name=track.findtext('./trackParameters/name','Speaker'),clips=clips,gain=gain,pan=pan,muted=params is not None and (truth(params.get('mute',False)) or truth(params.get('muted',False))),solo=params is not None and truth(params.get('solo',False))))
        for node in root.iter('xmpMetadata'):
            if node.text:
                try:
                    x=xml(node.text.encode())
                    for marker in x.iter('li'):
                        fields={child.tag:child.text for child in marker}
                        if fields.get('name') and fields.get('startTime'):self.notes.append(dict(seconds=number(fields['startTime'])/rate,text=fields['name']))
                except ET.ParseError:pass
        return tracks
    def soundcraft(self,name):
        if self.files[name].stat().st_size>32*1024**2:raise ImportError('Soundcraft session metadata is too large.')
        data=json.loads(self.files[name].read_text());rate=bounded(data.get('sample_rate'),1,384000)
        if data.get('format_version')!=1:raise ImportError('Unsupported Soundcraft session version.')
        if data.get('busses'):raise ImportError('Soundcraft bus routing requires rendered stems.')
        sources={s['id']:self.resolve(s['path'],name) for s in data.get('sources',[])}
        tracks=[]
        for track in data.get('tracks',[]):
            if track.get('kind')!='Audio':
                self.warnings.append('Non-audio Soundcraft track omitted: '+str(track.get('name','Track')));continue
            mixer=track.get('mixer',{})
            if track.get('automation') or any(v is not None for v in mixer.get('inserts',[])) or any(v is not None for v in mixer.get('sends',[])):raise ImportError('Soundcraft effects, sends or automation require rendered stems.')
            if mixer.get('output','Main')!='Main':raise ImportError('Custom Soundcraft output routing requires rendered stems.')
            playlists=track.get('playlists',[]);index=int(track.get('active_playlist',0))
            if index<0 or index>=len(playlists):raise ImportError('Soundcraft active playlist is missing.')
            clips=[]
            for node in playlists[index].get('clips',[]):
                if node.get('muted'):continue
                if node.get('gain_env') or number(node.get('stretch',1))!=1:raise ImportError('Soundcraft gain automation or time stretching requires rendered stems.')
                audio=node.get('content',{}).get('Audio')
                if not audio:raise ImportError('A Soundcraft audio clip has unsupported content.')
                if audio.get('source') not in sources:raise ImportError('Soundcraft clip refers to a missing source.')
                fades=[]
                for field in ('fade_in','fade_out'):
                    fade=node.get(field,{})
                    if fade.get('len',0) and (fade.get('shape') not in ('Linear',None) or fade.get('curvature',0)):raise ImportError('Nonlinear Soundcraft fades require rendered stems in this version.')
                    fades.append(number(fade.get('len',0))/rate)
                clips.append(self.clip(sources[audio['source']],number(node.get('start',0))/rate,number(audio.get('offset',0))/rate,number(node.get('length'))/rate,node.get('gain_db',0),*fades))
            pans=mixer.get('pan',[-1,1])
            if pans not in ([-1,1],[0,0]):raise ImportError('Custom Soundcraft stereo panning requires rendered stems in this version.')
            if clips:tracks.append(dict(name=track.get('name','Speaker'),clips=clips,gain=bounded(mixer.get('volume_db',0),-120,60),pan=0,muted=bool(mixer.get('mute')),solo=bool(mixer.get('solo'))))
        self.notes=[dict(seconds=number(m['start'])/rate,text=m.get('name','Marker')) for m in data.get('markers',[]) if m.get('kind')=='Marker']
        return tracks
    def aup3(self,name):
        db=sqlite3.connect('file:'+urllib.parse.quote(str(self.files[name]))+'?mode=ro&immutable=1',uri=True)
        try:
            db.execute('PRAGMA query_only=ON');db.execute('PRAGMA trusted_schema=OFF');db.execute('PRAGMA cache_size=-8192');db.execute('PRAGMA mmap_size=0')
            if db.execute('PRAGMA application_id').fetchone()[0]!=1096107097:raise ImportError('Not an Audacity AUP3 project.')
            row=db.execute('SELECT length(dict),length(doc) FROM project WHERE id=1').fetchone()
            if not row or sum(row)>32*1024**2:raise ImportError('Audacity project metadata is missing or too large. Save and close it in Audacity first.')
            if db.execute('SELECT count(*) FROM autosave').fetchone()[0]:raise ImportError('This Audacity project has unsaved recovery data. Recover, save and close it in Audacity, then upload the saved .aup3.')
            dictionary,document=db.execute('SELECT dict,doc FROM project WHERE id=1').fetchone();root=decode_project(dictionary+document)
            # Reject effects before rendering; the importer never executes plugins.
            if any(n.tag=='effect' or n.tag in ('effects','realtimeeffects') and len(n)>0 for n in root.iter()):raise ImportError('Audacity realtime effects require rendered stems.')
            tracks=[];wave_tracks=root.findall('wavetrack');index=0
            while index<len(wave_tracks):
                first=wave_tracks[index];channels=[first];index+=1
                if int(number(first.get('linked',0))) and index<len(wave_tracks):channels.append(wave_tracks[index]);index+=1
                per_channel=[]
                for channel in channels:
                    rate=bounded(channel.get('rate',root.get('rate',48000)),1,384000);clips=[]
                    for node in channel.findall('waveclip'):
                        if number(node.get('clipStretchRatio',1))!=1 or number(node.get('centShift',0))!=0:raise ImportError('Audacity pitch/time changes require rendered stems.')
                        if any(n.tag=='controlpoint' for n in node.iter()):raise ImportError('Audacity envelopes require rendered stems.')
                        if node.find('cutline') is not None:self.warnings.append('Hidden Audacity cutlines were not imported.')
                        sequences=node.findall('sequence')
                        if len(sequences)!=1:raise ImportError('This Audacity channel layout is unsupported. Export separate WAV/FLAC stems instead.')
                        seq=sequences[0];samples=int(bounded(seq.get('numsamples'),1,MAX_SECONDS*rate));raw=self.temp('.wav');expected=0
                        size=samples*4;fmt=struct.pack('<HHIIHH',3,1,int(rate),int(rate)*4,4,32)
                        if size<0xffffff00:header=b'RIFF'+struct.pack('<I',size+36)+b'WAVEfmt '+struct.pack('<I',16)+fmt+b'data'+struct.pack('<I',size)
                        else:header=b'RF64'+b'\xff'*4+b'WAVEds64'+struct.pack('<IQQQI',28,size+72,size,samples,0)+b'fmt '+struct.pack('<I',16)+fmt+b'data'+b'\xff'*4
                        with raw.open('wb') as output:
                            output.write(header)
                            for block in seq.findall('waveblock'):
                                start=int(bounded(block.get('start'),0,samples));bid=int(number(block.get('blockid')))
                                if start!=expected:raise ImportError('Audacity sample blocks are not contiguous.')
                                if bid<0:
                                    count=-bid
                                    if expected+count>samples:raise ImportError('Invalid Audacity silence block.')
                                    output.seek(count*4,1)
                                else:
                                    info=db.execute('SELECT sampleformat,length(samples) FROM sampleblocks WHERE blockid=?',(bid,)).fetchone()
                                    if not info or info[1]>8*1024**2:raise ImportError('Audacity sample block is missing or too large.')
                                    fmt,size=info;data=db.execute('SELECT samples FROM sampleblocks WHERE blockid=?',(bid,)).fetchone()[0]
                                    if fmt==0x20001:
                                        count=len(data)//2;values=struct.unpack('<'+'h'*count,data);data=struct.pack('<'+'f'*count,*(v/32768 for v in values))
                                    elif fmt==0x4000f:count=len(data)//4
                                    else:raise ImportError('Unsupported Audacity sample format.')
                                    if expected+count>samples:raise ImportError('Audacity block exceeds its sequence.')
                                    self.space(len(data));output.write(data)
                                expected+=count
                            if expected!=samples:raise ImportError('Audacity audio is incomplete.')
                            output.truncate(len(header)+samples*4)
                        media=self.temp('.flac');self.run(['-i',raw,'-c:a','flac','-sample_fmt','s32',media]);raw.unlink()
                        left=bounded(node.get('trimLeft',0));right=bounded(node.get('trimRight',0));at=number(node.get('offset',0))+left
                        clips.append(self.clip(media,at,left,samples/rate-left-right))
                    per_channel.append(clips)
                if not per_channel[0]:continue
                # Render each mono channel independently, then merge a linked stereo pair.
                rendered=[]
                for clips in per_channel:
                    target=self.temp('.flac');self.render(dict(clips=clips,gain=0,pan=0,muted=False),target,mono=True);rendered.append(target)
                merged=self.temp('.flac')
                if len(rendered)==2:self.run(['-i',rendered[0],'-i',rendered[1],'-filter_complex','[0:a]pan=stereo|c0=c0|c1=0*c0[left];[1:a]pan=stereo|c0=0*c0|c1=c0[right];[left][right]amix=inputs=2:duration=longest:normalize=0','-c:a','flac','-sample_fmt','s32',merged])
                else:merged=rendered[0]
                gain=number(first.get('gain',1));gain_db=20*math.log10(gain) if gain>0 else -120
                tracks.append(dict(name=first.get('name','Speaker'),clips=[self.clip(merged)],gain=gain_db,pan=bounded(first.get('pan',0),-1,1),muted=truth(first.get('mute',False)),solo=truth(first.get('solo',False))))
            for label in root.findall('./labeltrack/label'):self.notes.append(dict(seconds=bounded(label.get('t')),text=label.get('title','Marker')))
            return tracks
        finally:db.close()
    def shift(self,file,seconds,mono):
        # Stream a silent prefix rather than allocate an hours-long adelay buffer.
        with file.open('rb') as handle:header=handle.read(42)
        frames=int.from_bytes(header[18:26],'big')&0xfffffffff
        delay=round(seconds*48000);channels=1 if mono else 2;count=frames+delay;size=count*channels*4
        if count>48000*MAX_SECONDS:raise ImportError('Imported timeline exceeds 24 hours.')
        fmt=struct.pack('<HHIIHH',3,channels,48000,48000*channels*4,channels*4,32)
        header=b'RF64'+b'\xff'*4+b'WAVEds64'+struct.pack('<IQQQI',28,size+72,size,count,0)+b'fmt '+struct.pack('<I',16)+fmt+b'data'+b'\xff'*4
        target=self.temp('.flac');decoder=None;encoder=None
        with self.temp('.log').open('wb+') as log:
            try:
                encoder=subprocess.Popen([self.ffmpeg,'-nostdin','-v','error','-n','-i','pipe:0','-c:a','flac','-sample_fmt','s32',str(target)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=log)
                encoder.stdin.write(header);zero=bytes(1024**2);remaining=delay*channels*4
                while remaining:
                    self.space();part=min(remaining,len(zero));encoder.stdin.write(zero[:part]);remaining-=part
                decoder=subprocess.Popen([self.ffmpeg,'-nostdin','-v','error','-i',str(file),'-f','f32le','pipe:1'],stdout=subprocess.PIPE,stderr=log)
                while True:
                    data=decoder.stdout.read(1024**2)
                    if not data:break
                    self.space();encoder.stdin.write(data)
                decoder.stdout.close();encoder.stdin.close()
                if decoder.wait()!=0 or encoder.wait()!=0:raise ImportError('Could not prepare the project clip timing.')
            finally:
                for child in (decoder,encoder):
                    if child is not None:
                        if child.poll() is None:child.kill()
                        child.wait()
        file.unlink();return target
    def render(self,track,target,mono=False):
        rendered=[]
        for clip in track['clips']:
            self.space()
            filters=[f'aformat=sample_rates=48000:channel_layouts={"mono" if mono else "stereo"}',f'atrim=start={clip["offset"]}'+(f':duration={clip["length"]}' if clip['length'] is not None else ''),'asetpts=PTS-STARTPTS',f'volume={10**(clip["gain"]/20)}']
            if clip['fade_in']:filters.append(f'afade=t=in:d={clip["fade_in"]}')
            if clip['fade_out']:
                if clip['length'] is None:raise ImportError('Fade needs a known clip length.')
                filters.append(f'afade=t=out:st={max(0,clip["length"]-clip["fade_out"])}:d={clip["fade_out"]}')
            temp=self.temp('.flac');self.run(['-i',clip['file'],'-af',','.join(filters),'-t',str(MAX_SECONDS+1/48000),'-c:a','flac','-sample_fmt','s32',temp])
            with temp.open('rb') as handle:info=handle.read(42)
            frames=int.from_bytes(info[18:26],'big')&0xfffffffff
            if not frames:raise ImportError('A clip has no audio at its requested source position. Check the source media and session trims.')
            if clip['length'] is not None and frames+1<round(clip['length']*48000):self.warnings.append('A session clip extends beyond its source audio. The available source samples were preserved; the missing tail could not be restored.')
            rendered.append(self.shift(temp,clip['at'],mono) if clip['at'] else temp)
        while len(rendered)>1:
            group=rendered[:16];rest=rendered[16:];temp=self.temp('.flac')
            self.run([arg for f in group for arg in ('-i',f)]+['-filter_complex',f'amix=inputs={len(group)}:duration=longest:normalize=0','-c:a','flac','-sample_fmt','s32',temp])
            for f in group:f.unlink()
            rendered=rest+[temp]
        gain=0 if track.get('muted') else 10**(bounded(track.get('gain',0),-120,60)/20)
        pan=bounded(track.get('pan',0),-1,1)
        filters=f'volume={gain}'
        if not mono:filters+=f',aformat=channel_layouts=stereo,pan=stereo|c0={1-max(0,pan)}*c0|c1={1+min(0,pan)}*c1'
        self.run(['-i',rendered[0],'-af',filters,'-ar','48000','-ac','1' if mono else '2','-c:a','flac','-sample_fmt','s32',target]);rendered[0].unlink()
    def execute(self):
        self.uploads();projects=[n for n in self.files if pathlib.Path(n).suffix.lower() in PROJECT]
        kind=self.request.get('projectType','auto');preferred={'soundcraft':'.scraft','audition':'.sesx','audacity':'.aup3'}
        if kind in preferred:projects=[n for n in projects if pathlib.Path(n).suffix.lower()==preferred[kind]]
        if kind=='audio':projects=[]
        if len(projects)>1:raise ImportError('More than one session was found. Choose its application, or upload only the session you want to recover.')
        if kind in preferred and not projects:raise ImportError('No matching session file was uploaded.')
        if projects:
            name=projects[0];self.progress('Reading '+pathlib.PurePosixPath(name).name)
            tracks={'.sesx':self.audition,'.scraft':self.soundcraft,'.aup3':self.aup3}[pathlib.Path(name).suffix.lower()](name)
        else:
            tracks=[dict(name=pathlib.PurePosixPath(n).stem,clips=[self.clip(f)],gain=0,pan=0,muted=False,solo=False) for n,f in self.files.items() if pathlib.Path(n).suffix.lower() in AUDIO]
        if not tracks or len(tracks)>100:raise ImportError('Recovery needs between 1 and 100 audio tracks.')
        if sum(len(t['clips']) for t in tracks)>500:raise ImportError('Recovery supports at most 500 clips. Consolidate the source project first.')
        solo=any(t.get('solo') for t in tracks);result=[];duration=0
        for i,track in enumerate(tracks,1):
            self.progress(f'Preparing track {i} of {len(tracks)}: {track["name"]}')
            track['muted']=track.get('muted',False) or (solo and not track.get('solo'))
            out=self.output/f'source-track-{i}.flac';self.render(track,out)
            with out.open('rb') as handle:header=handle.read(42)
            if header[:4]!=b'fLaC':raise ImportError('Audio conversion did not produce a valid FLAC.')
            packed=int.from_bytes(header[18:26],'big');frames=packed&0xfffffffff
            if not 0<frames<=48000*MAX_SECONDS:raise ImportError('Imported track is empty or exceeds 24 hours.')
            duration=max(duration,frames);result.append(dict(track=i,id='recovery-'+str(i),username=str(track['name'])[:120],sourceFile=out.name))
        notes=[dict(seconds=bounded(n['seconds']),text=str(n['text'])[:2000]) for n in self.notes[:1000]]
        (self.output/'result.json').write_text(json.dumps(dict(tracks=result,durationSamples=duration,warnings=list(dict.fromkeys(self.warnings)),notes=notes)))
        shutil.rmtree(self.work)
        self.progress('Audio ready')

def decode_project(data):
    """Audacity fixed-width binary XML, bounded before allocating element trees."""
    at=0;char_size=0;names={};dictionaries=[];stack=[];root=None;nodes=0
    def take(count):
        nonlocal at
        if count<0 or at+count>len(data):raise ImportError('Truncated Audacity project metadata.')
        result=data[at:at+count];at+=count;return result
    def unpack(fmt):return struct.unpack('<'+fmt,take(struct.calcsize('<'+fmt)))[0]
    def text(length):
        raw=take(length)
        if char_size==1:return raw.decode('utf-8')
        if char_size==2:return raw.decode('utf-16-le')
        if char_size==4:return raw.decode('utf-32-le')
        raise ImportError('Invalid Audacity character size.')
    def field():
        key=unpack('H')
        if key not in names:raise ImportError('Unknown Audacity metadata field.')
        return names[key]
    while at<len(data):
        kind=unpack('B')
        if kind==0:char_size=unpack('B')
        elif kind==15:
            key=unpack('H');names[key]=text(unpack('H'))
        elif kind==13:dictionaries.append(names);names={}
        elif kind==14:
            if not dictionaries:raise ImportError('Invalid Audacity dictionary nesting.')
            names=dictionaries.pop()
        elif kind==1:
            node=ET.Element(field());nodes+=1
            if nodes>250000 or len(stack)>100:raise ImportError('Audacity metadata is too complex.')
            if stack:stack[-1].append(node)
            elif root is None:root=node
            else:raise ImportError('Multiple Audacity metadata roots.')
            stack.append(node)
        elif kind==2:
            if not stack or stack[-1].tag!=field():raise ImportError('Invalid Audacity tag nesting.')
            stack.pop()
        elif kind in (3,4,5,6,7,8,9,10):
            key=field()
            if not stack:raise ImportError('Audacity attribute outside an element.')
            if kind==3:value=text(unpack('i'))
            else:
                value=unpack({4:'i',5:'B',6:'i',7:'q',8:'I',9:'f',10:'d'}[kind])
                if kind in (9,10):take(4)
            stack[-1].set(key,str(value))
        elif kind in (11,12):text(unpack('i'))
        else:raise ImportError('Unsupported Audacity metadata field type.')
    if stack or root is None or root.tag!='project':raise ImportError('Incomplete Audacity project metadata.')
    return root

if __name__=='__main__':
    try:
        if sys.platform.startswith('linux'):
            import resource
            resource.setrlimit(resource.RLIMIT_AS,(1024**3,1024**3))
        request=json.loads(pathlib.Path(sys.argv[1]).read_text());Recovery(request,sys.argv[2],sys.argv[3]).execute()
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,(ImportError,zipfile.BadZipFile,ET.ParseError,json.JSONDecodeError)) else 'Project import failed. Check that the session and all media are complete.'}),flush=True)
        print(repr(error),file=sys.stderr);sys.exit(1)
