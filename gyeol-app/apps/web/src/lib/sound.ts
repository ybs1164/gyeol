import { settings } from './storage';
import { vibrate } from './platform';

/** 나무 타일 느낌의 짧은 소리. 파일 없이 합성한다. */
let ctx: AudioContext | undefined;

function tock(freq: number, delay = 0, gain = 0.18) {
  if (!settings.get().sound) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.08);
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(amp).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch {
    /* 소리 재생 불가 — 무시 */
  }
}

export const sound = {
  place: () => {
    tock(240);
    if (settings.get().vibrate) vibrate(8);
  },
  flip: (count: number) => {
    for (let k = 0; k < count; k++) tock(360 + k * 40, 0.38 + k * 0.14, 0.12);
  },
  end: () => {
    tock(300);
    tock(400, 0.12);
  },
};
