/**
 * The time as an atproto TID, ticking: the clock Anisota shows under its feed when nobody's
 * signed in (its TIDClock, @atproto/common-web's TID.nextStr), drawn the atpotato way: in
 * atpotato's own face, not Anisota's mono, each character in a cell of its own so it holds still.
 *
 * A TID is 13 characters of base32-sortable: 11 for the microseconds since 1970 and 2 for
 * a clock id (0-1023) that tells two clocks apart. Every record key Bluesky makes is one,
 * so the clock is the record key a post made right now would get.
 *
 * Every [data-ov-tid] under the root gets the TID, one <span> a character so the ones that
 * just changed can glow (.is-new); [data-ov-tid-stamp] and [data-ov-tid-clock] get its two
 * parts, [data-ov-tid-time] the time it means to the microsecond and [data-ov-tid-date]
 * the day. It ticks every TICK_MS, and skips what's hidden.
 */

export const S32 = '234567abcdefghijklmnopqrstuvwxyz';
export const TICK_MS = 50;

/** `n` in base32-sortable, at least `len` characters. */
export function s32(n: number, len: number): string {
  let out = '';
  let v = Math.max(0, Math.floor(n));
  while (v > 0) {
    out = S32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out.padStart(len, '2');
}

/** The TID for `us` microseconds since 1970 on clock `clock`. */
export function tidAt(us: number, clock: number): string {
  return s32(us, 11) + s32(clock & 1023, 2);
}

/** A TID's microseconds and clock id, or null when it isn't one. */
export function readTid(tid: string): { us: number; clock: number } | null {
  if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(tid)) return null;
  let us = 0;
  for (const c of tid.slice(0, 11)) us = us * 32 + S32.indexOf(c);
  return { us, clock: S32.indexOf(tid[11]!) * 32 + S32.indexOf(tid[12]!) };
}

/** "14:03:12.345678", in this device's zone. */
export function tidTimeText(us: number): string {
  const d = new Date(Math.floor(us / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(us % 1_000_000).padStart(6, '0')}`;
}

/** "thursday 22 october 2026". */
export function tidDateText(us: number): string {
  return new Date(Math.floor(us / 1000)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase().replace(',', '');
}

/** A clock that never says the same TID twice, as TID.nextStr. */
export function createTidClock(nowUs: () => number = () => Math.floor((performance.timeOrigin + performance.now()) * 1000), clock = Math.floor(Math.random() * 1024)) {
  let last = 0;
  return () => {
    let us = nowUs();
    if (us <= last) us = last + 1;
    last = us;
    return { tid: tidAt(us, clock), us };
  };
}

export interface TidOptions {
  win?: Window;
  next?: () => { tid: string; us: number };
}

/** Ticks every TID display under root. */
export function mountTid(root: ParentNode, opts: TidOptions = {}): { tick(): void } {
  const win = opts.win ?? window;
  const next = opts.next ?? createTidClock();
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const all = <T extends HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const boxes = all('[data-ov-tid]').map((el) => {
    const chars = Array.from({ length: 13 }, (_, i) => {
      const c = doc.createElement('span');
      c.className = i < 11 ? 'ov-tid__c' : 'ov-tid__c ov-tid__c--clock';
      return c;
    });
    el.replaceChildren(...chars);
    el.setAttribute('translate', 'no');
    return { el, chars, was: '' };
  });
  const parts = { stamp: all('[data-ov-tid-stamp]'), clock: all('[data-ov-tid-clock]'), time: all('[data-ov-tid-time]'), date: all('[data-ov-tid-date]') };
  const shown = (el: HTMLElement) => !el.closest('[hidden]');
  let day = '';

  const tick = () => {
    const { tid, us } = next();
    for (const b of boxes) {
      if (!shown(b.el)) continue;
      for (let i = 0; i < 13; i++) {
        const c = b.chars[i]!;
        const changed = b.was[i] !== tid[i];
        if (changed) c.textContent = tid[i]!;
        c.classList.toggle('is-new', changed && b.was !== '');
      }
      b.was = tid;
      b.el.setAttribute('aria-label', tid);
    }
    for (const el of parts.stamp) if (shown(el)) el.textContent = tid.slice(0, 11);
    for (const el of parts.clock) if (shown(el)) el.textContent = tid.slice(11);
    for (const el of parts.time) if (shown(el)) el.textContent = tidTimeText(us);
    const today = tidDateText(us);
    if (today !== day) {
      day = today;
      for (const el of parts.date) el.textContent = today;
    }
  };
  tick();
  if (boxes.length || parts.time.length) win.setInterval(tick, TICK_MS);
  return { tick };
}
