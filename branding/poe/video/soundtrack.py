# Original synthesized music bed + sound effects for the Poe promo (no samples, no licensed music).
import math, random, struct, wave
SR, DUR, BPM = 44100, 35.0, 100
BEAT = 60 / BPM
N = int(SR * DUR)
buf = [0.0] * N
random.seed(3)

def add(t0, samples, gain=1.0):
    i0 = int(t0 * SR)
    for k, v in enumerate(samples):
        i = i0 + k
        if 0 <= i < N: buf[i] += v * gain

def pluck(freq, dur=0.5, bright=0.35):
    n = int(dur * SR)
    return [(math.sin(2 * math.pi * freq * k / SR) + bright * math.sin(4 * math.pi * freq * k / SR) + bright * 0.4 * math.sin(6 * math.pi * freq * k / SR))
            * math.exp(-k / SR * 7) * min(1, k / 80) for k in range(n)]

def noise(dur, env):
    n = int(dur * SR); out = []; lp = 0.0
    for k in range(n):
        lp += 0.25 * (random.uniform(-1, 1) - lp); out.append(lp * env(k / n))
    return out

note = lambda m: 440 * 2 ** ((m - 69) / 12)
CHORDS = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]]   # C Am F G
PATTERN = [0, 1, 2, 3, 2, 1, 2, 3]
end = DUR - 1.0
t, bar = 0.0, 0
while t < end:
    ch = CHORDS[bar % 4]
    for e in range(8):
        te = t + e * BEAT / 2
        if te < end: add(te, pluck(note(ch[PATTERN[e]] + 12), 0.45), 0.10)
    for b in (0, 2):                                   # bass on beats 1 and 3
        add(t + b * BEAT, pluck(note(ch[0] - 24), 0.9, 0.15), 0.16)
    for b in range(4):                                  # soft hats on the off-beats
        add(t + b * BEAT + BEAT / 2, noise(0.05, lambda x: (1 - x) ** 3), 0.05)
    t += 4 * BEAT; bar += 1

# sound effects
def chime(t0, freqs, gain=0.18):
    for i, f in enumerate(freqs): add(t0 + i * 0.09, pluck(f, 0.8, 0.1), gain)
def pop(t0):
    n = int(0.18 * SR); add(t0, [math.sin(2 * math.pi * (900 - 2600 * k / SR) * k / SR) * math.exp(-k / SR * 22) for k in range(n)], 0.35)
def whoosh(t0, dur=0.6, gain=0.22):
    add(t0, noise(dur, lambda x: math.sin(math.pi * x) ** 2), gain)
chime(1.35, [1318.5, 1760])                            # the mention arrives
chime(2.30, [880, 1174.7], 0.12)                        # eyes open
pop(3.50)
for c in [5.0, 10.0, 16.5, 23.0, 28.5]: whoosh(c - 0.3)
chime(5.5, [1046.5]); chime(5.9, [1318.5, 1568])       # meet / poe
for i in range(4): pop(12.0 + i * 0.55)                 # the stats pop in
add(11.2, noise(3.9, lambda x: min(1, x * 8) * min(1, (1 - x) * 6)), 0.06)   # the firehose spray
add(16.5, noise(6.5, lambda x: min(1, x * 5) * min(1, (1 - x) * 5)), 0.035)  # rain
whoosh(20.2, 1.2, 0.2)                                   # jetstream gust
for i in range(4): pop(24.1 + i * 0.6)                   # questions pop up
chime(26.9, [1046.5, 1318.5, 1568])                      # "i really do!"
chime(28.9, [784, 1046.5, 1318.5, 1568], 0.16)           # end card

# master: gentle fade in/out, soft clip
peak = 0.0
for i in range(N):
    tt = i / SR
    g = min(1, tt / 0.4) * min(1, max(0, (DUR - tt) / 1.4))
    v = math.tanh(buf[i] * g * 1.4) * 0.8
    buf[i] = v; peak = max(peak, abs(v))
with wave.open('out/soundtrack.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<h', int(max(-1, min(1, v)) * 32000)) for v in buf))
print('peak', round(peak, 3))
