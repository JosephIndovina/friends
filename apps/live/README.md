# Friends Live

Native streamer for Windows and Ubuntu: a screen or window plus **one app's audio**, published to the stage
(LiveKit) as a `ScreenShare` + `ScreenShareAudio` pair named `screen-…` / `screen-…-audio`, the same way the
browser does it. Browsers can't capture a single app's sound; this can.

- Video: WebRTC's desktop capturer (Windows Graphics Capture; xdg-desktop-portal + PipeWire on Wayland).
- Audio: PipeWire app streams on Linux; WASAPI process loopback on Windows (not written yet).

## Build (Ubuntu)

Needs Rust (`rustup`) and **clang** — libwebrtc is built against Chromium's libc++ and won't link with GCC:

```sh
sudo apt install clang libclang-dev libpipewire-0.3-dev
CC=clang CXX=clang++ cargo build --release
```

## Try it

```sh
friends-live apps                                  # apps playing sound right now
friends-live record --app Firefox --seconds 5      # check capture → capture.wav
friends-live stream --url wss://<site>/livekit --token <token> --app Firefox --fps 60 --height 1080
```

On Wayland `stream` opens the system picker for the screen or window.

## Gotcha: PipeWire stubs

libwebrtc.a defines weak `pw_*` stubs (it `dlopen`s PipeWire lazily), and they beat the real libpipewire at
link time. They're null until `webrtc::InitializePipeWire()` runs, so `audio/linux.rs` calls it before touching
PipeWire. Without that, the first `pw_init` segfaults.
