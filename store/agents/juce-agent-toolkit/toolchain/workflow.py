import array
import math
import platform
import os
from pathlib import Path
import wave
from studio_runtime import execute, metric, command, package, workspace, contained


def summarize(p, out, engine):
    with wave.open(str(out / "phrase.wav"), "rb") as f:
        if f.getsampwidth() != 2 or f.getnchannels() != 1:
            raise ValueError("Expected a 16-bit mono recording")
        samples = array.array("h", f.readframes(f.getnframes()))
        rate = f.getframerate()
    peak = max((abs(x) for x in samples), default=0) / 32768
    if peak >= .999 or not samples:
        raise ValueError("The recording clipped or was empty")
    rms = math.sqrt(sum((x / 32768) ** 2 for x in samples) / len(samples))
    return {"title": f'{p["wave"].capitalize()} · {p["frequency"]} Hz',
            "description": "A four-note phrase rendered locally. Play it, inspect the waveform, or download the WAV.",
            "engine": engine, "metrics": [metric("Peak level", round(20 * math.log10(max(peak, 1e-8)), 1), "dBFS"),
                metric("RMS level", round(20 * math.log10(max(rms, 1e-8)), 1), "dBFS"),
                metric("Recording", round(len(samples) / rate, 2), "s")],
            "data": {"waveform": [round(x / 32768, 4) for x in samples[::max(1, len(samples) // 600)]], "sampleRate": rate},
            "files": [{"label": "WAV recording", "name": "phrase.wav"}]}


def render(p, out):
    rate = 44100
    samples = array.array("h")
    count = int(p["duration"] * rate)
    filtered = 0.
    alpha = 1 - math.exp(-2 * math.pi * (250 + 5000 * p["brightness"]) / rate)
    for i in range(count):
        t = i / rate
        segment = min(3, int(4 * t / p["duration"]))
        local = t - segment * p["duration"] / 4
        frequency = p["frequency"] * 2 ** ([0, 7, 12, 3][segment] / 12)
        phase = (t * frequency) % 1
        value = math.sin(phase * 2 * math.pi)
        if p["wave"] == "triangle":
            value = 1 - 4 * abs(phase - .5)
        elif p["wave"] == "saw":
            # Finite harmonics avoid the unbounded discontinuity of a naive saw.
            value = sum(math.sin(2 * math.pi * phase * n) / n for n in range(1, min(24, int(rate / (2 * frequency))))) * .5
        envelope = min(1, local / p["attack"], max(0, (p["duration"] / 4 - local) / .08))
        filtered += alpha * (value - filtered)
        samples.append(round(filtered * envelope * .3 * 32767))
    with wave.open(str(out / "phrase.wav"), "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate); f.writeframes(samples.tobytes())
    return summarize(p, out, "Local DSP · Python renderer")


def juce(p, out):
    source = contained(workspace() / "CMakeLists.txt")
    if not source.exists():
        raise RuntimeError("The workspace needs its CMakeLists.txt and Source/main.cpp starter.")
    build = contained(workspace() / ".harness/juce-build")
    cmake = package() / ".venv/bin/cmake"
    print("Compiling the native JUCE instrument…", flush=True)
    flags=[];env=dict(os.environ)
    if platform.system()=='Darwin':
        sdk=command(['xcrun','--show-sdk-path']).strip();flags.append('-DCMAKE_OSX_SYSROOT='+sdk)
        env['SDKROOT']=sdk
        # Recent Apple SDKs carry libc++ headers inside the SDK, including for juceaide's nested build.
        headers=Path(sdk)/'usr/include/c++/v1'
        if headers.is_dir():env['CPLUS_INCLUDE_PATH']=str(headers)+(os.pathsep+env['CPLUS_INCLUDE_PATH'] if env.get('CPLUS_INCLUDE_PATH') else '')
    command([cmake, "-S", workspace(), "-B", build, f'-DJUCE_ROOT={package() / "juce"}', "-DCMAKE_BUILD_TYPE=Release",*flags], timeout=600,env=env)
    command([cmake, "--build", build, "--target", "HarnessTone", "-j", "2"], timeout=600,env=env)
    binary = build / "HarnessTone_artefacts/Release/HarnessTone"
    command([binary, out / "phrase.wav", p["wave"], str(p["frequency"]), str(p["attack"]), str(p["brightness"]), str(p["duration"])])
    result = summarize(p, out, "Native JUCE · offline instrument")
    return result


if __name__ == "__main__":
    execute({"render": render, "juce": juce})
