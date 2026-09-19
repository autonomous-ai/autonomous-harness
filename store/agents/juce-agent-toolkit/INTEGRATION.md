# Local DSP and native JUCE offline rendering

`render` writes a mono PCM WAV and measures its peak and RMS; `juce` compiles `CMakeLists.txt` and `Source/main.cpp` in the workspace against the pinned JUCE modules, then measures the recorded WAV. The native renderer needs a C++ compiler/SDK; no DAW is required. JUCE toolkit skills under `upstream/skills` cover full plugin projects beyond this starter.

## Verification scope

Play the on-screen keys, change waveform/brightness, record, download, and compare history. Native JUCE was compiled and rendered on the Intel Mac. The output is an offline instrument renderer, not a packaged VST3.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
