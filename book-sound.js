"use strict";
/* ==========================================================================
   Book sound: page-turn audio synthesized with the Web Audio API
   --------------------------------------------------------------------------
   No audio files. Paper is shaped noise:
     lift    a quick crinkle as the corner leaves the page
     swish   filtered air that follows the turn, loudest mid-turn
     settle  a faint papery tap as the sheet lands
   Hardcover boards add a low hinge creak and a soft thump.
   While a page is dragged, a continuous rustle follows the pointer speed.

   Browsers only allow audio after a user gesture, so the context is created
   on the first tap/click/key. script.js calls window.BookSound; every method
   is safe to call before audio is unlocked or when sound is muted.
   ========================================================================== */
(() => {
  const STORAGE_KEY = "book-sound";
  const MASTER_VOLUME = .55;
  let ctx = null;
  let master = null;
  let whiteNoise = null;
  let crackle = null;
  let drag = null;
  let muted = false;
  try { muted = window.localStorage.getItem(STORAGE_KEY) === "off"; } catch { /* storage unavailable */ }

  const vary = (value, amount = .12) => value * (1 + (Math.random() * 2 - 1) * amount);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function makeBuffers() {
    const length = ctx.sampleRate * 2;
    whiteNoise = ctx.createBuffer(1, length, ctx.sampleRate);
    const white = whiteNoise.getChannelData(0);
    for (let i = 0; i < length; i += 1) white[i] = Math.random() * 2 - 1;

    // Paper crackle: sparse, uneven clicks over a faint noise floor.
    crackle = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = crackle.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * .08;
      if (Math.random() < .0018) {
        const size = 6 + Math.floor(Math.random() * 30);
        const peak = (Math.random() * 2 - 1) * (.4 + Math.random() * .6);
        for (let j = 0; j < size && i + j < length; j += 1) data[i + j] += peak * (1 - j / size);
      }
    }
  }

  function unlock() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      ctx = new AudioContextClass();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.ratio.value = 3;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_VOLUME;
      master.connect(compressor).connect(ctx.destination);
      makeBuffers();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  const ready = () => Boolean(ctx && ctx.state === "running" && !muted);

  // A noise source started at a random point so repeats never sound identical.
  function noise(buffer, when, duration) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const offset = Math.random() * (buffer.duration - .5);
    source.start(when, offset);
    source.stop(when + duration + .05);
    return source;
  }

  function filter(type, frequency, q = .8) {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
  }

  function envelope(when, attack, hold, release, peak) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.setValueAtTime(peak, when + attack + hold);
    gain.gain.exponentialRampToValueAtTime(.0001, when + attack + hold + release);
    return gain;
  }

  function lift(when, level) {
    const duration = vary(.12);
    noise(crackle, when, duration)
      .connect(filter("highpass", vary(2600)))
      .connect(envelope(when, .008, .02, duration, .32 * level))
      .connect(master);
  }

  function swish(when, duration, level, bright = 1) {
    const band = filter("bandpass", vary(1500 * bright), .7);
    band.frequency.setValueAtTime(vary(1300 * bright), when);
    band.frequency.linearRampToValueAtTime(vary(3200 * bright), when + duration * .45);
    band.frequency.exponentialRampToValueAtTime(vary(1000 * bright), when + duration);
    noise(whiteNoise, when, duration)
      .connect(filter("highpass", 350))
      .connect(band)
      .connect(envelope(when, duration * .42, duration * .08, duration * .5, .24 * level))
      .connect(master);
    // A little crackle rides along: paper is never a perfectly smooth hiss.
    noise(crackle, when, duration)
      .connect(filter("bandpass", vary(3800), 1.2))
      .connect(envelope(when, duration * .35, duration * .1, duration * .55, .14 * level))
      .connect(master);
  }

  function settle(when, level) {
    noise(whiteNoise, when, .09)
      .connect(filter("bandpass", vary(900), 1.1))
      .connect(envelope(when, .004, .01, .08, .14 * level))
      .connect(master);
  }

  function creak(when, duration, level) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(vary(82, .1), when);
    osc.frequency.linearRampToValueAtTime(vary(118, .1), when + duration);
    const wobble = ctx.createOscillator();
    const depth = ctx.createGain();
    wobble.frequency.value = vary(13, .3);
    depth.gain.value = 9;
    wobble.connect(depth).connect(osc.frequency);
    osc.connect(filter("bandpass", vary(650), 7))
      .connect(envelope(when, duration * .3, duration * .3, duration * .4, .035 * level))
      .connect(master);
    osc.start(when); wobble.start(when);
    osc.stop(when + duration + .05); wobble.stop(when + duration + .05);
  }

  function thump(when, level) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(vary(78, .08), when);
    osc.frequency.exponentialRampToValueAtTime(42, when + .18);
    osc.connect(envelope(when, .006, .02, .22, .26 * level)).connect(master);
    osc.start(when); osc.stop(when + .3);
    noise(whiteNoise, when, .12)
      .connect(filter("lowpass", 420))
      .connect(envelope(when, .004, .01, .1, .16 * level))
      .connect(master);
  }

  /*
    One complete turn, scheduled to match the animation.
    duration  seconds the visual turn takes
    hard      true for a hardcover board
    level     overall loudness (riffles and snap-backs are quieter)
    lifted    false when continuing from a drag (the corner is already up)
  */
  function turn({ duration = .85, hard = false, level = 1, lifted = true } = {}) {
    if (!ready()) return;
    const now = ctx.currentTime + .01;
    const length = Math.max(.12, duration);
    if (hard) {
      creak(now, length * .55, level);
      swish(now + length * .15, length * .7, level * .55, .55);
      thump(now + length * .96, level);
      return;
    }
    if (lifted) lift(now, level);
    swish(now + (lifted ? .03 : 0), length, level);
    settle(now + length * .97, level * .9);
  }

  function peel() {
    if (!ready()) return;
    lift(ctx.currentTime + .005, .35);
  }

  // Continuous rustle while the reader holds the page.
  function dragStart(hard = false) {
    if (!ready() || drag) return;
    const now = ctx.currentTime;
    const band = filter("bandpass", hard ? 500 : 1400, hard ? 1.4 : .7);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const source = ctx.createBufferSource();
    source.buffer = hard ? whiteNoise : crackle;
    source.loop = true;
    source.connect(filter("highpass", hard ? 120 : 400)).connect(band).connect(gain).connect(master);
    source.start(now, Math.random());
    drag = { source, band, gain, hard };
    if (!hard) lift(now, .55);
  }

  // speed: pointer speed in px/ms.
  function dragMove(speed) {
    if (!drag || !ctx) return;
    const now = ctx.currentTime;
    const amount = clamp(Math.abs(speed) / 1.6, 0, 1);
    const top = drag.hard ? .16 : .5;
    drag.gain.gain.setTargetAtTime(amount * top, now, .05);
    drag.band.frequency.setTargetAtTime((drag.hard ? 380 : 1100) + amount * (drag.hard ? 500 : 2600), now, .06);
  }

  function dragEnd() {
    if (!drag || !ctx) { drag = null; return; }
    const { source, gain } = drag;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0, now, .04);
    source.stop(now + .3);
    drag = null;
  }

  function setMuted(value) {
    muted = Boolean(value);
    try { window.localStorage.setItem(STORAGE_KEY, muted ? "off" : "on"); } catch { /* storage unavailable */ }
    if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, ctx.currentTime, .05);
    if (muted) dragEnd();
  }

  // Unlock audio on the first gesture of any kind (iOS needs a tap/click).
  ["pointerdown", "pointerup", "click", "keydown", "touchend"].forEach((type) => {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  });

  window.BookSound = {
    turn, peel, dragStart, dragMove, dragEnd, setMuted, unlock,
    get muted() { return muted; },
    get running() { return Boolean(ctx && ctx.state === "running"); },
  };
})();
