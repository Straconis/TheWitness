# Recording-start audio

## Default recording notice

`NowRecording.opus` is the original recording notice supplied by Straconis, the
project owner, for inclusion in The Witness. It is copied without changes from
`NowRecordng.opus` in VM-Share; the repository name corrects the spelling.

`witness-start.ogg` is the runtime version of that notice: 3.8 seconds, Ogg Opus,
48 kHz stereo, 96 kb/s, 20 ms frames. It is loudness matched with a -20 LUFS target
and -3 dBTP ceiling. Measurements of the encoded file: approximately -20.37 LUFS
and -7.54 dBTP. The peak ceiling limits gain; it does not force every file to peak
at -3 dBTP. Eris parses 190 packets and all decode successfully.

Conversion (requires FFmpeg with libopus):

```bash
bin/ffmpeg -nostdin -v error -y -protocol_whitelist file,pipe -f ogg \
  -i assets/audio/NowRecording.opus -map_metadata -1 -vn \
  -af aformat=channel_layouts=stereo,loudnorm=I=-20:TP=-3:LRA=11 \
  -ar 48000 -ac 2 -c:a libopus -b:a 96k -application audio \
  -frame_duration 20 -f ogg assets/audio/witness-start.ogg
```

## Optional synthesized chime

`witness-chime.ogg` is the previous original default: three rising sine/bell tones
(E5, A5, E6), 1.36 seconds of Opus packets, stereo, 96 kb/s, 20 ms frames,
loudness matched to -20 LUFS with a -3 dBTP ceiling. It was synthesized from
scratch by `scripts/generate-start-chime.py`, with no samples, third-party audio
or Craig assets, and is covered by the project license. The generator now writes
this optional chime rather than replacing the recording-notice default. Eris parses its
68 packets and all decode successfully.

The `.sha256` files identify shipped assets. Regeneration/conversion reproduces
the audio, but encoded bytes can differ with FFmpeg versions and Ogg serial
numbers. Update the checksum and asset test deliberately when changing the
shipped default.
