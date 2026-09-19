import array
import json
import math
import os
import re
import struct
import sys
import wave
from studio_runtime import execute, metric, package

SCALES = {"minor": [0, 3, 5, 7, 10], "major": [0, 4, 5, 7, 11], "pentatonic": [0, 2, 4, 7, 9]}


def notes(p):
    if p["pattern"]:
        if not re.fullmatch('[01]{16}',p["pattern"]):
            raise ValueError('A custom rhythm must contain sixteen steps')
        slots=[i for i,v in enumerate(p["pattern"]) if v=='1']
    else:
        # The browser uses this same integer LCG and Fisher–Yates shuffle.
        state = p["seed"]
        slots = list(range(16))
        for i in range(15, 0, -1):
            state = (state * 1664525 + 1013904223) & 0xffffffff
            j = state * (i + 1) // 4294967296
            slots[i], slots[j] = slots[j], slots[i]
        slots = sorted(slots[:p["density"]])
    return [{"step": s, "note": 48 + SCALES[p["scale"]][(s+p["seed"]) % 5], "velocity": 75 + (s*17+p["seed"]*13) % 36,
             "beat": s / 4 + (p["swing"] / 4 if s % 2 else 0), "length": .22} for s in slots]


def variable_length(value):
    result = [value & 127]
    while value >> 7:
        value >>= 7
        result.insert(0, (value & 127) | 128)
    return bytes(result)


def render(p, out):
    pattern = notes(p)
    rate = 22050
    duration = 4 * 60 / p["tempo"]
    samples = [0.] * int((duration + .4) * rate)
    events = []
    tempo = round(60_000_000 / p["tempo"])
    for note in pattern:
        start = int(note["beat"] * 60 / p["tempo"] * rate)
        length = int((note["length"] * 60 / p["tempo"] + .15) * rate)
        frequency = 440 * 2 ** ((note["note"] - 69) / 12)
        for i in range(min(length, len(samples)-start)):
            t = i / rate
            envelope = min(1, t / .008) * math.exp(-t * 9)
            samples[start+i] += math.sin(2 * math.pi * frequency * t) * envelope * note["velocity"] / 127 * .32
        tick = round(note["beat"] * 480)
        events.extend([(tick, bytes([0x90,note["note"],note["velocity"]])), (tick+round(note["length"]*480),bytes([0x80,note["note"],0]))])
    raw = array.array('h',[round(max(-.99,min(.99,x))*32767) for x in samples])
    with wave.open(str(out/'loop.wav'),'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate); f.writeframes(raw.tobytes())
    track = b'\x00\xff\x51\x03' + tempo.to_bytes(3,'big')
    previous = 0
    for tick,event in sorted(events,key=lambda v:(v[0],v[1][0])):
        track += variable_length(tick-previous) + event
        previous = tick
    track += variable_length(max(0,1920-previous)) + b'\xff\x2f\x00'
    (out/'loop.mid').write_bytes(b'MThd'+struct.pack('>IHHH',6,0,1,480)+b'MTrk'+struct.pack('>I',len(track))+track)
    (out/'notes.json').write_text(json.dumps(pattern,indent=2))
    return {"title":f'{p["scale"].capitalize()} groove · {p["tempo"]} BPM',
            "description":"A playable local synth sketch. The MIDI keeps the exact notes, timing, velocity, swing and tempo.",
            "engine":"Local MIDI + synthesized audio", "metrics":[metric("Tempo",p["tempo"],"BPM"),metric("Notes",len(pattern)),metric("Loop length",round(duration,2),"s")],
            "data":{"notes":pattern,"duration":duration},"files":[{"label":"MIDI pattern","name":"loop.mid"},{"label":"WAV loop","name":"loop.wav"},{"label":"Note events","name":"notes.json"}]}


def live(p,out):
    sys.path.insert(0,str(package()/'upstream/src'))
    from ableton_ai.connection import AbletonConnection
    from ableton_ai.config import Settings
    try:
        with AbletonConnection(Settings(host=os.environ.get('ABLETON_HOST','localhost'),port=int(os.environ.get('ABLETON_PORT','9877')),max_connect_attempts=1,recv_timeout=3,read_cmd_timeout=3,command_delay=0)) as connection:
            snapshot=connection.send_command('get_session_info',retry=False)
    except Exception as exc:
        raise RuntimeError('Open Ableton Live and enable its AbletonAI Control Surface on port 9877. '+str(exc)) from exc
    (out/'live-session.json').write_text(json.dumps(snapshot,indent=2))
    return {"title":"Live session snapshot","description":"Read directly from Ableton. No tracks or transport were changed.","engine":"Ableton Live · local bridge","metrics":[metric("Tempo",snapshot.get('tempo','—'),"BPM"),metric("Tracks",len(snapshot.get('tracks',[])))],"data":{"session":snapshot},"files":[{"label":"Live snapshot","name":"live-session.json"}]}


if __name__=='__main__':
    execute({'render':render,'live':live})
