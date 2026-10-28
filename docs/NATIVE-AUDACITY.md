# Native Audacity export

Witness writes a self-contained `session.aup3`, or `backup-audacity.aup3` for a selected Soundcraft backup. It embeds the rendered, synchronized stereo tracks and the note markers. Intro tracks are embedded after the existing intro/loudness pipeline. The source recording and separate rendered audio are not modified by project creation.

The writer is an original compatibility implementation based on the Audacity 3.7.9 format. Authoritative references at tag `Audacity-3.7.9` (commit `86d74c770974b25188ca2f23bcce47c1181bd08a`):

- [ProjectSerializer](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/ProjectSerializer.cpp): dictionary-backed binary XML, including UTF-8 string attributes.
- [ProjectFileIO](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/ProjectFileIO.cpp): SQLite schema, application identifier and version fields.
- [SQLite sample blocks](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/SqliteSampleBlock.cpp): PCM blocks, summaries, virtual silence and block sharing.
- WaveTrack, WaveClip and Sequence XML handlers in the same source tree define track/channel/clip positions.

The runtime needs Node 24's SQLite API and FFmpeg with s16le/f32le PCM output. Audacity itself is not installed or launched on the VPS. A worker thread handles SQLite and waveform summaries with a 256 MiB JavaScript heap limit; sample buffers, decoder pipes and ZIP compression are bounded. This heap limit is not a claim that total process memory is limited to 256 MiB. The native-file writer checks free space against the recording reserve. The queue's existing emergency guard and temporary-directory cleanup still apply.

16-bit WAV/FLAC uses Audacity int16 blocks. Higher-bit FLAC uses float32, which exactly represents its 24-bit integer sample values. Entirely zero blocks use negative block IDs; identical PCM blocks share one database row. Native files are uncompressed when opened, but ZIP entries are streamed with DEFLATE level 1. Standalone Audacity ZIPs omit duplicate processed WAV/FLAC media. Soundcraft/Audition backups still need their separate media alongside the embedded native project. Existing legacy `.aup` download packages remain supported.

Validation includes an independent SQLite/binary-XML reader, byte/sample equality across block boundaries and partial blocks, asymmetric stereo, virtual silence, float conversion, ZIP extraction/CRC, speaker/marker metadata, cancellation and overwrite protection. The native tests also pass inside a 512 MiB RAM / zero-swap / two-core cgroup. An official SHA256-verified Audacity 3.7.9 AppImage opens the generated file with correct stereo metadata/notes, saves it again, and its CompareAudio command reads the embedded tone and silent blocks with exactly the expected nonzero-sample count. These small fixtures do not establish the peak disk footprint or completion time for a full three-hour recording.
