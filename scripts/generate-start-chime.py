#!/usr/bin/env python3
"""Regenerate assets/audio/witness-start.ogg, The Witness's original start chime.
Pure synthesis (no samples or third-party audio). Requires the bundled ffmpeg with libopus.
Usage: python3 scripts/generate-start-chime.py [ffmpeg-path]"""
import math, os, struct, subprocess, sys, tempfile, wave
rate=48000; total=int(rate*1.35)
notes=[(0.00,659.25),(0.18,880.00),(0.36,1318.51)]  # E5, A5, E6 rising chime
buf=[0.0]*total
for start,freq in notes:
    s0=int(start*rate)
    for i in range(s0,total):
        t=(i-s0)/rate
        env=min(1,t/0.012)*math.exp(-t*3.2)
        v=(math.sin(2*math.pi*freq*t)+0.35*math.sin(2*math.pi*2*freq*t)*math.exp(-t*6)+0.12*math.sin(2*math.pi*3*freq*t)*math.exp(-t*9))
        buf[i]+=0.22*env*v
tail=int(0.15*rate)
for i in range(total-tail,total): buf[i]*=(total-i)/tail
peak=max(abs(x) for x in buf); buf=[x/peak*0.6 for x in buf]
ffmpeg=sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(__file__),'..','bin','ffmpeg')
out=os.path.join(os.path.dirname(__file__),'..','assets','audio','witness-start.ogg')
os.makedirs(os.path.dirname(out),exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    wav=os.path.join(tmp,'chime.wav')
    with wave.open(wav,'wb') as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<hh',int(x*32767),int(x*32767)) for x in buf))
    subprocess.run([ffmpeg,'-hide_banner','-v','error','-y','-i',wav,'-af','loudnorm=I=-20:TP=-3:LRA=7','-ar','48000','-ac','2','-c:a','libopus','-b:a','96k','-application','audio','-frame_duration','20','-f','ogg',out],check=True)
print('Wrote',os.path.normpath(out))
