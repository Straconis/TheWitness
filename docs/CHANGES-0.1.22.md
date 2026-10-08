# 0.1.22 — use the owner's recording notice by default

The default recording-start sound is now the owner's supplied NowRecording
notice. The original file is included unchanged as `assets/audio/NowRecording.opus`;
a normalized 3.8-second stereo Ogg Opus copy is used at `assets/audio/witness-start.ogg`.
The playback copy has 20 ms frames at 48 kHz/96 kb/s. Its measured loudness is
approximately -20.37 LUFS and its true peak is -7.54 dBTP, below the -3 dBTP ceiling.

Per-server Custom and Off modes and the host override work as before. Playback
still happens once per new recording and never blocks capture. The previous
synthesized chime remains as an optional asset; its generator now writes
`witness-chime.ogg`, preserving the recording-notice default. Asset provenance, checksums,
conversion instructions, dashboard wording and README/help are updated.

Validation: 187/187 local tests; the default parses into 190 packets with Eris,
all frames decode, duration is 3.8 seconds and the shipped checksum matches.
The original source copy is byte-identical to the owner's supplied file. No
playback logic or root admin tools changed. Live DAVE playback and acoustic-echo
checks remain pending. Deployment is explicit and manual.
