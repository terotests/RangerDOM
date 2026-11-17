#!/bin/sh
# SPDX-License-Identifier: MIT
#
# The macOS app from static libraries built elsewhere (build.mjs
# --native-lib with NATIVE_TARGETS=aarch64-apple-darwin,x86_64-apple-darwin,
# which needs no Mac): only this last step runs on a Mac. It needs the
# Command Line Tools (clang, lipo, codesign) and SDL3, which it builds from
# source as a static, universal library when SDL3_PREFIX has none (that
# needs cmake and git).
#
#   playground/native/mac-link.sh <dir with librangerdom_native-*.a> <cases dir> [out dir]
#
# -> <out>/RangerDOM Demo.app (and rangerdom-demo, sizes.txt)
set -eu
LIBS=${1:?dir with librangerdom_native-<target>.a}
CASES=${2:?cases dir}
OUT=${3:-$PWD/out}
HERE=$(cd "$(dirname "$0")" && pwd)
SDL_VERSION=${SDL_VERSION:-3.2.24}
SDL3_PREFIX=${SDL3_PREFIX:-$HOME/.cache/rangerdom/sdl3-$SDL_VERSION}
export MACOSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-11.0}
mkdir -p "$OUT"

if [ ! -f "$SDL3_PREFIX/lib/libSDL3.a" ]; then
  echo "==> SDL3 $SDL_VERSION (static, arm64 + x86_64, video + render only)"
  SRC=$(mktemp -d)/sdl
  git clone -q --depth 1 -b "release-$SDL_VERSION" https://github.com/libsdl-org/SDL "$SRC"
  cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DCMAKE_INSTALL_PREFIX="$SDL3_PREFIX" \
    -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TEST_LIBRARY=OFF -DSDL_TESTS=OFF -DSDL_EXAMPLES=OFF \
    -DSDL_AUDIO=OFF -DSDL_JOYSTICK=OFF -DSDL_HAPTIC=OFF -DSDL_HIDAPI=OFF -DSDL_SENSOR=OFF \
    -DSDL_CAMERA=OFF -DSDL_POWER=OFF -DSDL_GPU=OFF -DSDL_DIALOG=OFF
  cmake --build "$SRC/build" --parallel 2
  cmake --install "$SRC/build"
fi
# the static library's frameworks, from its pkg-config file (SDL 3.2 puts
# them on the Libs: line, after -L and -lSDL3)
SDL_FLAGS="$(sed -n 's/^Libs\(.private\)\{0,1\}: *//p' "$SDL3_PREFIX/lib/pkgconfig/sdl3.pc" | tr ' ' '\n' | grep -v -e '^-L' -e '^-lSDL3$' -e '^$' | tr '\n' ' ') -lobjc"

MAIN="$OUT/main.c"
printf 'int rangerdom_demo_main(void);\nint main(void) { return rangerdom_demo_main(); }\n' > "$MAIN"
THIN=""
for pair in arm64:aarch64-apple-darwin x86_64:x86_64-apple-darwin; do
  arch=${pair%%:*}; target=${pair#*:}
  lib="$LIBS/librangerdom_native-$target.a"
  [ -f "$lib" ] || continue
  echo "==> link $arch"
  # (64 MB main thread stack: deep pages lay out deep)
  clang -arch "$arch" -O2 "$MAIN" "$lib" "$SDL3_PREFIX/lib/libSDL3.a" $SDL_FLAGS \
    -Wl,-dead_strip -Wl,-stack_size,0x4000000 -o "$OUT/rangerdom-demo-$arch"
  strip -x "$OUT/rangerdom-demo-$arch"
  THIN="$THIN $OUT/rangerdom-demo-$arch"
done
[ -n "$THIN" ] || { echo "no librangerdom_native-<target>.a in $LIBS"; exit 1; }
lipo -create -output "$OUT/rangerdom-demo" $THIN

APP="$OUT/RangerDOM Demo.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/rangerdom-demo" "$APP/Contents/MacOS/"
cp -R "$CASES" "$APP/Contents/Resources/cases"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
codesign --force --deep -s - "$APP"

{
  for b in "$OUT/rangerdom-demo" $THIN; do echo "$(basename "$b"): $(stat -f %z "$b") bytes"; done
  echo "arm64 gzip -9: $(gzip -9c "$OUT/rangerdom-demo-arm64" | wc -c | tr -d ' ') bytes"
  echo "cases: $(du -sk "$CASES" | cut -f1) KB"
  echo "app: $(du -sk "$APP" | cut -f1) KB"
} | tee "$OUT/sizes.txt"
echo "==> $APP"
