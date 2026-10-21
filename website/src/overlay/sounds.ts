/**
 * Poe's little noises on stream, made with WebAudio (no sound files): a soft two-note
 * chirp for a hello, a rising run for a follow, a boop for a pet, a bell for a weather
 * alert, a fanfare for going live, and a yawn as it dozes off. OBS hears them when the
 * browser source's "Control audio via OBS" is on; ?sound=off keeps Poe quiet and
 * ?volume=0-100 sets how loud (default 40).
 *
 * A browser that won't play sound before someone clicks (not OBS) just stays silent.
 */

export type Sound = 'hello' | 'follow' | 'pet' | 'alert' | 'live' | 'talk' | 'yawn';

/** Each sound as notes: [frequency Hz, start s, length s], and the wave that plays them. */
export const TUNES: Record<Sound, { wave: OscillatorType; notes: Array<[number, number, number]> }> = {
  hello: { wave: 'sine', notes: [[660, 0, 0.12], [880, 0.1, 0.18]] },
  follow: { wave: 'triangle', notes: [[523, 0, 0.12], [659, 0.09, 0.12], [784, 0.18, 0.12], [1047, 0.27, 0.3]] },
  pet: { wave: 'sine', notes: [[440, 0, 0.08], [330, 0.07, 0.16]] },
  alert: { wave: 'sine', notes: [[988, 0, 0.5], [1319, 0.02, 0.6]] },
  live: { wave: 'triangle', notes: [[392, 0, 0.14], [523, 0.12, 0.14], [659, 0.24, 0.14], [784, 0.36, 0.45]] },
  talk: { wave: 'sine', notes: [[720, 0, 0.09]] },
  yawn: { wave: 'sine', notes: [[420, 0, 0.5], [300, 0.35, 0.6]] },
};

export interface Sounds {
  play(sound: Sound): void;
}

export const SILENT: Sounds = { play() {} };

type AudioCtor = new () => AudioContext;

export function createSounds(volume: number, win: Window = window): Sounds {
  const Ctor = (win as Window & { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }).AudioContext ?? (win as Window & { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor || volume <= 0) return SILENT;
  let ctx: AudioContext | null = null;
  const gain = Math.min(1, volume / 100) * 0.25;
  return {
    play(sound) {
      try {
        ctx ??= new Ctor();
        if (ctx.state === 'suspended') void ctx.resume();
        const tune = TUNES[sound];
        const t0 = ctx.currentTime + 0.02;
        for (const [freq, start, length] of tune.notes) {
          const osc = ctx.createOscillator();
          const env = ctx.createGain();
          osc.type = tune.wave;
          osc.frequency.setValueAtTime(freq, t0 + start);
          // a quick swell and a soft tail, so nothing clicks
          env.gain.setValueAtTime(0, t0 + start);
          env.gain.linearRampToValueAtTime(gain, t0 + start + 0.015);
          env.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
          osc.connect(env).connect(ctx.destination);
          osc.start(t0 + start);
          osc.stop(t0 + start + length + 0.05);
        }
      } catch {
        // no sound is fine
      }
    },
  };
}
