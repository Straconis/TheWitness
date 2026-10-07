#!/bin/sh
# Rebuild the bundled LGPL-only audio tool from the accompanying source archives.
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TASK_BUILD="$TASK_ROOT/work/portable/build"
TASK_PREFIX="$TASK_ROOT/work/portable/prefix"
mkdir -p "$TASK_PREFIX" "$TASK_ROOT/bin"
cd "$TASK_BUILD/opus-1.6.1"
./configure --prefix="$TASK_PREFIX" --disable-shared --enable-static --disable-extra-programs --disable-doc --disable-dred > "$TASK_ROOT/work/portable/opus-configure.log" 2>&1
make -j2 > "$TASK_ROOT/work/portable/opus-build.log" 2>&1
make install > "$TASK_ROOT/work/portable/opus-install.log" 2>&1
cd "$TASK_BUILD/lame-3.100"
./configure --prefix="$TASK_PREFIX" --disable-shared --enable-static --disable-frontend > "$TASK_ROOT/work/portable/lame-configure.log" 2>&1
make -j2 > "$TASK_ROOT/work/portable/lame-build.log" 2>&1
make install > "$TASK_ROOT/work/portable/lame-install.log" 2>&1
cd "$TASK_BUILD/ffmpeg-7.1.5"
PKG_CONFIG_PATH="$TASK_PREFIX/lib/pkgconfig" ./configure --prefix="$TASK_PREFIX" \
 --disable-shared --enable-static --disable-doc --disable-debug --disable-autodetect \
 --disable-everything --enable-ffmpeg --disable-ffplay --disable-ffprobe \
 --disable-x86asm --enable-small --pkg-config-flags=--static \
 --extra-cflags="-I$TASK_PREFIX/include" --extra-ldflags="-L$TASK_PREFIX/lib -static" \
 --enable-protocol=file,pipe --enable-demuxer=ogg,wav,flac,mp3,mov,aac,pcm_s16le \
 --enable-muxer=ogg,wav,flac,mp3,mp4,adts,pcm_s16le,null \
 --enable-decoder=opus,pcm_s16le,flac,mp3,mp3float,aac \
 --enable-encoder=libopus,pcm_s16le,flac,libmp3lame,aac \
 --enable-parser=opus,flac,mpegaudio,aac --enable-libopus --enable-libmp3lame \
 --enable-filter=aresample,amix,anull,atrim,asetpts,adelay,volume,pan,afade,apad,asplit,loudnorm \
 > "$TASK_ROOT/work/portable/ffmpeg-configure.log" 2>&1
make -j2 > "$TASK_ROOT/work/portable/ffmpeg-build.log" 2>&1
cp ffmpeg "$TASK_ROOT/bin/ffmpeg"
cc -static -O2 -o "$TASK_ROOT/bin/oggcorrect" "$TASK_ROOT/cook/oggcorrect.c"
printf '%s\n' 'Portable FFmpeg and Craig correction tool built.'
