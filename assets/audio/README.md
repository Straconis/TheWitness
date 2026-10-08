# witness-start.ogg

Original start-of-recording chime for The Witness: three rising sine/bell tones
(E5, A5, E6), 1.36 s, Ogg Opus, 48 kHz stereo, 96 kb/s, 20 ms frames, loudness-normalized
(loudnorm I=-20 LUFS, TP=-3 dBTP). It was synthesized from scratch by
scripts/generate-start-chime.py. It contains no samples, recordings or third-party audio,
and no Craig assets. It's covered by the project's own license.

Verified: Eris/dysnomia's OggOpusTransformer parses it into 68 Opus packets; all decode
(1.36 s, 0 errors).

The checksum identifies the shipped file. Regeneration reproduces the synthesized
chime; encoded bytes can differ with FFmpeg versions and Ogg stream serial numbers.
Update the checksum and asset test deliberately if replacing the shipped asset.
