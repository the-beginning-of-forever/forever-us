"use strict";
/* ==========================================================================
   Book sound: page-turn audio
   --------------------------------------------------------------------------
   Real recordings first. sounds/page-turn-1…5.m4a are single page turns of
   a printed book (CC0, "Book Flip Sounds" by Voltiment555, opengameart.org),
   trimmed and level-matched. Each turn plays one of them, never the same
   twice in a row, with its landing lined up to the moment the page lands.
   The cover uses a recording slowed and muffled, with a low board thud.
   While a page is dragged it is silent apart from the pickup as the corner
   is taken; the landing plays when it is let go.

   Fallback: if the recordings cannot load, the synthesized model below is
   used instead, modelled on a 70–80 GSM book page:
     crinkle   hundreds of tiny clicks (0.5–5 ms) as the fibres flex; their
               density follows how sharply the sheet is bending
     rustle    bright friction noise (energy around 2–6 kHz) whose loudness
               flutters irregularly as the sheet wobbles through the air
     air       a faint low whoosh of moved air
     peel      a few stick-slip clicks as the page leaves the one below
     flap      a soft, muffled paper-on-paper landing with a small bounce
   Hardcover boards: cloth rub, sparse spine crackle, more air and a low thud.

   Each turn is rendered sample by sample into a fresh buffer whose length
   matches the animation, so the landing lands when the page does. Rendering
   takes a couple of milliseconds.

   Browsers allow audio only after a user gesture, so the context is created
   on the first tap/click/key. script.js calls window.BookSound; every method
   is safe to call before audio is unlocked or while muted.
   ========================================================================== */
(() => {
  const STORAGE_KEY = "book-sound";
  const MASTER_VOLUME = .7;
  let ctx = null;
  let master = null;
  let room = null;
  let drag = null;
  let muted = false;
  try { muted = window.localStorage.getItem(STORAGE_KEY) === "off"; } catch { /* storage unavailable */ }

  const rand = (min, max) => min + Math.random() * (max - min);
  const white = () => Math.random() * 2 - 1;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 2000 }) : window.setTimeout(fn, 250));

  /* ---- Recorded page turns --------------------------------------------- */

  const RECORDINGS = [1, 2, 3, 4, 5].map((n) => `./sounds/page-turn-${n}.m4a`);
  let clips = [];          // { buffer, hit }: hit = seconds until the page lands
  let lastClip = -1;
  let thud = null;

  // The landing is the loudest moment after the first third of the clip.
  function findLanding(buffer) {
    const data = buffer.getChannelData(0);
    const hop = Math.floor(buffer.sampleRate * .005);
    let best = 0;
    let at = 0;
    for (let i = Math.floor(data.length / 3); i + hop < data.length; i += hop) {
      let sum = 0;
      for (let j = 0; j < hop; j += 1) sum += data[i + j] * data[i + j];
      if (sum > best) { best = sum; at = i; }
    }
    return at / buffer.sampleRate;
  }

  /*
    Every recording is split into the three things a page does:
      pickup   the corner being taken and lifted (first ~0.1 s)
      travel   the rustle while the sheet is in the air
      landing  the flap onto the stack, and its short tail
    A turn is assembled from these parts, often from different recordings,
    and each part is shaped by how that page is actually being turned.
  */
  function describe(buffer) {
    const hit = findLanding(buffer);
    const pickupEnd = clamp(hit * .22, .05, .12);
    return {
      buffer, hit,
      pickup: [0, pickupEnd],
      travel: [pickupEnd, Math.max(pickupEnd + .08, hit - .05)],
      landing: [Math.max(0, hit - .03), buffer.duration],
    };
  }

  /*
    Decoded with an offline context, so no user gesture is needed to load.
    sounds/recordings.js carries the same files as base64, which works even
    when the book is opened straight from disk (file://), where fetch() is
    blocked. The .m4a files are fetched only if that script is missing.
  */
  function base64ToBuffer(text) {
    const bytes = window.atob(text);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) out[i] = bytes.charCodeAt(i);
    return out.buffer;
  }

  function loadRecordings() {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return;
    const decoder = new Offline(1, 1, 44100);
    const decode = (data) => new Promise((resolve, reject) => decoder.decodeAudioData(data, resolve, reject));
    const embedded = Array.isArray(window.BOOK_RECORDINGS) ? window.BOOK_RECORDINGS : null;
    const sources = embedded
      ? embedded.map((text) => Promise.resolve(base64ToBuffer(text)))
      : RECORDINGS.map((url) => (window.fetch ? fetch(url) : Promise.reject(new Error("no fetch")))
        .then((response) => { if (!response.ok) throw new Error(url); return response.arrayBuffer(); }));
    Promise.all(sources.map((source) => source.then(decode).then(describe).catch(() => null)))
      .then((list) => { clips = list.filter(Boolean); });
  }

  /*
    Choose a recording from a physical value (0..1) instead of at random, so
    the same kind of grab tends toward the same character, with a little
    natural spread, and never the identical recording twice in a row.
  */
  function clipFor(value, avoid = -1) {
    const n = clips.length;
    let index = clamp(Math.floor((value + rand(-.18, .18)) * n), 0, n - 1);
    if (n > 1 && (index === avoid || index === lastClip)) index = (index + 1 + Math.floor(Math.random() * (n - 1))) % n;
    lastClip = index;
    return { clip: clips[index], index };
  }

  function playClip(clip, {
    when, offset = 0, rate = 1, level = 1, pan = 0, panTo = -pan, tone = 0,
    fadeIn = 0, length = 0, fadeOut = 0,
  }) {
    const source = ctx.createBufferSource();
    source.buffer = clip.buffer;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(fadeIn ? 0 : level, when);
    if (fadeIn) gain.gain.linearRampToValueAtTime(level, when + fadeIn);
    if (length) {
      const out = fadeOut || Math.min(.04, length * .4);
      gain.gain.setValueAtTime(level, when + length - out);
      gain.gain.linearRampToValueAtTime(0, when + length);
    }
    let node = source;
    if (tone) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = Math.min(tone, ctx.sampleRate * .45);
      node = node.connect(lowpass);
    }
    node = node.connect(gain);
    if ((pan || panTo) && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      const span = length || (clip.buffer.duration - offset) / rate;
      panner.pan.setValueAtTime(clamp(pan, -1, 1), when);
      panner.pan.linearRampToValueAtTime(clamp(panTo, -1, 1), when + span);
      node = node.connect(panner);
    }
    node.connect(master);
    node.connect(room);
    source.start(when, offset);
    if (length) source.stop(when + length + .01);
    return source;
  }

  // Pages near either cover pull stiffer at the spine than mid-book pages.
  const stiffness = (depth) => 1 - Math.min(depth, 1 - depth) * 2;

  // Pickup: a pinched corner crackles sharper and higher than an edge grab.
  function pickup(when, t) {
    const cornerness = t.corner === "top" ? 1 - t.grabY : t.grabY;      // 1 = right at the corner
    const { clip } = clipFor(cornerness);
    const [a, b] = clip.pickup;
    const length = b - a;
    const rate = (.94 + cornerness * .12 + stiffness(t.depth) * .06) * rand(.98, 1.02);
    const side = t.spread ? .45 : .2;
    playClip(clip, {
      when, offset: a, rate, length: length / rate, fadeOut: .02,
      level: t.level * (.45 + cornerness * .35 + stiffness(t.depth) * .2),
      tone: 5000 + cornerness * 9000,
      pan: t.forward ? side : -side, panTo: t.forward ? side * .8 : -side * .8,
    });
  }

  /*
    One real recording, played whole and untouched, so only the paper's own
    sound is heard. What the turn decides:
      which recording   from where the page was taken and the stack below
      speed             slowed or quickened slightly so its landing lands
                        exactly when the animated page does
      tone and level    faster turns are a little brighter and louder; a
                        thin stack near the board lands duller
      direction         the sound moves across with the page
      snap-back         a page let go early is much quieter
  */
  function turnRecorded(t) {
    const now = ctx.currentTime + .005;
    const land = Math.max(.12, t.duration * .96);
    if (t.hard) {
      // A board: a page recording slowed and muffled, with a low thud.
      const { clip } = clipFor(Math.random());
      const rate = rand(.7, .78);
      const travelTime = clip.hit / rate;
      const delay = Math.max(0, land - travelTime);
      const offset = travelTime > land ? clip.hit - land * rate : 0;
      playClip(clip, {
        when: now + delay, offset, rate, level: t.level * 1.1, pan: .12, tone: 2800,
        fadeIn: offset > .01 ? .03 : 0,
      });
      thud ??= toBuffer(normalize(makeThud(), .7));
      // Closing onto the page block is firmer than opening onto the desk.
      play(thud, { when: now + land - .005, level: t.level * (t.forward ? .75 : .95) });
      return;
    }

    const cornerness = t.corner === "top" ? 1 - t.grabY : t.grabY;
    const { clip } = clipFor(cornerness * .5 + t.stack * .5);
    const rate = clamp(clip.hit / land, .88, 1.14) * (.97 + t.stack * .05) * rand(.98, 1.02);
    // After a drag the page is already up, so start part-way into the clip.
    const earliest = t.lifted ? 0 : clip.hit * .45;
    const travelTime = (clip.hit - earliest) / rate;
    let delay = 0;
    let offset = earliest;
    if (travelTime <= land) delay = land - travelTime;
    else offset = clip.hit - land * rate;
    const side = t.spread ? .45 : .2;
    playClip(clip, {
      when: now + delay, offset, rate,
      level: t.level * (.6 + t.pace * .45) * (t.snapBack ? .4 : 1),
      tone: 4000 + t.stack * 5000 + t.pace * 6000,
      fadeIn: offset > .01 ? .03 : 0,
      pan: t.forward ? side : -side,
      panTo: t.forward ? -side : side,
    });
    // Right against the board, the cover gives the landing a little body.
    if (t.stack < .1 && !t.snapBack) {
      thud ??= toBuffer(normalize(makeThud(), .7));
      play(thud, { when: now + land, level: t.level * .18 * (1 - t.stack * 10) });
    }
  }

  /* ---- Tiny DSP toolkit (RBJ biquads, run in place) --------------------- */

  function biquad(type, frequency, q, gainDb = 0) {
    const sr = ctx.sampleRate;
    const w0 = 2 * Math.PI * Math.min(frequency, sr * .45) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const A = 10 ** (gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === "lowpass") { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
    else if (type === "highpass") { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
    else if (type === "bandpass") { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
    else { b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function filter(data, ...stages) {
    for (const [type, frequency, q, gain] of stages) {
      const [b0, b1, b2, a1, a2] = biquad(type, frequency, q, gain);
      let z1 = 0;
      let z2 = 0;
      for (let i = 0; i < data.length; i += 1) {
        const x = data[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        data[i] = y;
      }
    }
    return data;
  }

  // Smooth random wobble (cosine-interpolated points every 10–35 ms).
  function flutter(length, depth) {
    const sr = ctx.sampleRate;
    const out = new Float32Array(length);
    let i = 0;
    let from = Math.random();
    while (i < length) {
      const span = Math.floor(sr * rand(.01, .035));
      const to = Math.random();
      for (let j = 0; j < span && i < length; j += 1, i += 1) {
        const t = (1 - Math.cos(Math.PI * j / span)) / 2;
        out[i] = 1 - depth + depth * 2 * (from + (to - from) * t);
      }
      from = to;
    }
    return out;
  }

  // Sparse clicks whose rate (per second) and size follow shape(u), u = 0..1.
  function crinkle(data, start, length, maxRate, size, shape, longest = .005) {
    const sr = ctx.sampleRate;
    let t = 0;
    const seconds = length / sr;
    while (t < seconds) {
      t += -Math.log(1 - Math.random()) / maxRate;
      const u = t / seconds;
      if (u >= 1) break;
      const density = shape(u);
      if (Math.random() > density) continue;           // thinning: rate follows shape
      const grain = Math.floor(sr * (.0005 + Math.random() ** 2 * longest));
      const amp = size * density * (.2 + Math.random() ** 3 * 1.8);
      const decay = grain / 3;
      const at = start + Math.floor(t * sr);
      for (let j = 0; j < grain && at + j < data.length; j += 1) {
        data[at + j] += white() * amp * Math.exp(-j / decay);
      }
    }
  }

  // Bend of the sheet over the turn: rises fast, peaks ~40%, eases out.
  const bend = (u) => (u < .4
    ? Math.sin((u / .4) * Math.PI / 2) ** 1.6
    : Math.cos(((u - .4) / .6) * Math.PI / 2) ** 1.25);

  function mixInto(data, layer, gain, start = 0) {
    for (let i = 0; i < layer.length && start + i < data.length; i += 1) data[start + i] += layer[i] * gain;
  }

  function normalize(data, peak) {
    let max = 0;
    for (let i = 0; i < data.length; i += 1) max = Math.max(max, Math.abs(data[i]));
    if (max > 0) for (let i = 0; i < data.length; i += 1) data[i] *= peak / max;
    // Tiny fades so a buffer never clicks at its edges.
    const fade = Math.min(64, data.length >> 2);
    for (let i = 0; i < fade; i += 1) { data[i] *= i / fade; data[data.length - 1 - i] *= i / fade; }
    return data;
  }

  /* ---- Sound recipes ---------------------------------------------------- */

  // Soft paper-on-paper landing with a smaller bounce just after.
  function flap(data, at, level) {
    const sr = ctx.sampleRate;
    const length = Math.floor(sr * .09);
    const hit = new Float32Array(length);
    const bounce = Math.floor(sr * rand(.018, .03));
    for (let i = 0; i < length; i += 1) {
      const first = Math.exp(-i / (sr * .012));
      const second = i > bounce ? .35 * Math.exp(-(i - bounce) / (sr * .008)) : 0;
      hit[i] = white() * (first + second);
    }
    filter(hit, ["lowpass", rand(1800, 2600), .7], ["peaking", rand(380, 520), 1, 5]);
    mixInto(data, hit, level, at);
    crinkle(data, at, Math.floor(sr * .05), 260, .05 * level, (u) => 1 - u, .002);
  }

  function renderPage(seconds, level, lifted) {
    const sr = ctx.sampleRate;
    const length = Math.floor(sr * seconds);
    const tail = Math.floor(sr * .12);
    const data = new Float32Array(length + tail);
    const wobble = flutter(length, .55);

    // Rustle: bright friction noise that flutters with the sheet.
    const rustle = new Float32Array(length);
    for (let i = 0; i < length; i += 1) rustle[i] = white() * bend(i / length) * wobble[i];
    filter(rustle, ["highpass", rand(800, 1100), .7], ["peaking", rand(3200, 4600), .8, 6], ["lowpass", rand(9000, 11000), .7]);
    mixInto(data, rustle, .55);

    // Crinkle: micro-clicks clustered where the bend is sharpest.
    const crisp = new Float32Array(length);
    crinkle(crisp, 0, length, 520, .9, (u) => bend(u) ** 1.3);
    filter(crisp, ["highpass", 1400, .7], ["lowpass", 9500, .7]);
    mixInto(data, crisp, 1);

    // Air: the low whoosh of the moving sheet.
    const air = new Float32Array(length);
    for (let i = 0; i < length; i += 1) air[i] = white() * bend(i / length) ** 2;
    filter(air, ["lowpass", rand(380, 520), .7], ["lowpass", 600, .7]);
    mixInto(data, air, .9);

    // Peel: stick-slip as the page leaves the one beneath it.
    if (lifted) crinkle(data, 0, Math.floor(sr * .07), 420, .5, (u) => 1 - u, .003);

    flap(data, Math.floor(length * .96), .42);
    return normalize(data, .55 * level);
  }

  function makeThud() {
    const sr = ctx.sampleRate;
    const thud = new Float32Array(Math.floor(sr * .18));
    for (let i = 0; i < thud.length; i += 1) {
      const t = i / sr;
      thud[i] = Math.sin(2 * Math.PI * 82 * t) * Math.exp(-t / .07) * .9
        + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / .035) * .45
        + white() * Math.exp(-t / .012) * .5;
    }
    return filter(thud, ["lowpass", 1400, .7]);
  }

  function renderBoard(seconds, level) {
    const sr = ctx.sampleRate;
    const length = Math.floor(sr * seconds);
    const data = new Float32Array(length + Math.floor(sr * .2));
    const motion = (u) => Math.sin(Math.PI * Math.min(1, u / .95)) ** 1.4;

    // Cloth rub and sparse spine crackle as the hinge flexes.
    const rub = new Float32Array(length);
    for (let i = 0; i < length; i += 1) rub[i] = white() * motion(i / length) * .5;
    crinkle(rub, 0, Math.floor(length * .45), 90, .7, (u) => 1 - u, .006);
    filter(rub, ["bandpass", rand(1100, 1500), .8], ["lowpass", 4000, .7]);
    mixInto(data, rub, .6);

    // A heavier board pushes more air.
    const air = new Float32Array(length);
    for (let i = 0; i < length; i += 1) air[i] = white() * motion(i / length) ** 2;
    filter(air, ["lowpass", 320, .7], ["lowpass", 420, .7]);
    mixInto(data, air, 1.4);

    // Thud: the board settling onto the page block.
    const at = Math.floor(length * .97);
    mixInto(data, makeThud(), 1, at);
    crinkle(data, at + Math.floor(sr * .02), Math.floor(sr * .08), 200, .06, (u) => 1 - u, .002);
    return normalize(data, .7 * level);
  }

  // Loopable rustle bed for dragging (cross-faded so the loop is seamless).
  function renderDragBed(hard) {
    const sr = ctx.sampleRate;
    const length = sr * 3;
    const fade = Math.floor(sr * .15);
    const data = new Float32Array(length + fade);
    const wobble = flutter(data.length, .6);
    for (let i = 0; i < data.length; i += 1) data[i] = white() * wobble[i] * (hard ? .6 : .45);
    if (!hard) crinkle(data, 0, data.length, 380, .8, () => .8);
    filter(data, ...(hard
      ? [["bandpass", 900, .8], ["lowpass", 2500, .7]]
      : [["highpass", 900, .7], ["peaking", 4000, .8, 6], ["lowpass", 10000, .7]]));
    for (let i = 0; i < fade; i += 1) {
      const t = i / fade;
      data[i] = data[i] * t + data[length + i] * (1 - t);
    }
    const loop = data.subarray(0, length);
    return toBuffer(normalize(loop, .5));
  }

  function toBuffer(data) {
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    return buffer;
  }

  /* ---- Playback ---------------------------------------------------------- */

  function unlock() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      ctx = new AudioContextClass();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.ratio.value = 2.5;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_VOLUME;
      master.connect(compressor).connect(ctx.destination);

      // A whisper of room so the paper sounds near, not inside your head.
      const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * .16), ctx.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const data = ir.getChannelData(channel);
        for (let i = 0; i < data.length; i += 1) data[i] = white() * Math.exp(-i / (ctx.sampleRate * .03));
        filter(data, ["lowpass", 5000, .7]);
      }
      const convolver = ctx.createConvolver();
      convolver.buffer = ir;
      room = ctx.createGain();
      room.gain.value = .16;
      room.connect(convolver).connect(master);
      window.setTimeout(prewarm, 1500);   // only renders if the recordings failed
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  const ready = () => Boolean(ctx && ctx.state === "running" && !muted);

  // Play a rendered buffer, drifting across the stereo field like a page.
  function play(buffer, { pan = 0, level = 1, when = ctx.currentTime + .005 } = {}) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    let out = source;
    if (level !== 1) {
      const gain = ctx.createGain();
      gain.gain.value = level;
      out = out.connect(gain);
    }
    if (ctx.createStereoPanner && pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(pan, when);
      panner.pan.linearRampToValueAtTime(-pan, when + buffer.duration * .9);
      out = out.connect(panner);
    }
    out.connect(master);
    out.connect(room);
    source.start(when);
    return source;
  }

  /*
    One complete turn, matched to the animation.
    duration  seconds the visual turn takes
    hard      true for a hardcover board
    level     overall loudness (riffles and snap-backs are quieter)
    lifted    false when continuing from a drag (the corner is already up)
  */
  const TURN_DEFAULTS = {
    duration: .85, hard: false, level: 1, lifted: true, forward: true,
    depth: .5, stack: .5, spread: false, corner: "bottom", grabY: .9,
    bend: .35, pace: .65, curve: "inout", snapBack: false,
  };

  function turn(options = {}) {
    if (!ready()) return;
    const t = { ...TURN_DEFAULTS, ...options };
    if (clips.length) { turnRecorded(t); return; }
    play(take(t.hard, Math.max(.15, t.duration), t.lifted), { pan: t.hard ? .15 : .3, level: t.level });
  }

  /*
    Rendering takes ~10 ms, too long for the frame a turn starts in, so a
    few variations of the common turn lengths are rendered ahead in idle
    time. Lengths are bucketed to 50 ms; anything unusual renders live.
  */
  const pool = new Map();
  const bucket = (seconds) => Math.round(seconds * 20) / 20;
  const poolKey = (hard, seconds, lifted) => `${hard ? "board" : "page"}:${bucket(seconds)}:${hard ? "" : lifted}`;
  const render = (hard, seconds, lifted) => toBuffer(hard ? renderBoard(seconds, 1) : renderPage(seconds, 1, lifted));

  function refill(hard, seconds, lifted) {
    const key = poolKey(hard, seconds, lifted);
    const list = pool.get(key) || [];
    pool.set(key, list);
    if (list.length >= 3 || list.filling) return;
    list.filling = true;
    idle(() => {
      list.filling = false;
      if (!ctx) return;
      list.push(render(hard, bucket(seconds), lifted));
      if (list.length < 3) refill(hard, seconds, lifted);
    });
  }

  function take(hard, seconds, lifted) {
    const list = pool.get(poolKey(hard, seconds, lifted));
    const buffer = list?.length ? list.shift() : render(hard, bucket(seconds), lifted);
    refill(hard, seconds, lifted);
    return buffer;
  }

  // Turn lengths used by script.js: button turns, cover, and riffles.
  function prewarm() {
    if (clips.length) return;
    refill(false, .85, true);
    refill(true, 1.05, false);
    refill(false, .62, true);
    refill(true, .8, false);
    idle(() => { beds ??= { soft: renderDragBed(false), hard: renderDragBed(true) }; });
  }

  function peel() {
    if (!ready()) return;
    if (clips.length) {
      // The corner lifting slightly under the cursor: a faint pickup.
      const { clip } = clipFor(.85);
      playClip(clip, { when: ctx.currentTime + .005, offset: clip.pickup[0], length: .09, level: .22, fadeOut: .03, tone: 9000 });
      return;
    }
    const sr = ctx.sampleRate;
    const data = new Float32Array(Math.floor(sr * .08));
    crinkle(data, 0, data.length, 500, .6, (u) => 1 - u, .003);
    filter(data, ["highpass", 1500, .7]);
    play(toBuffer(normalize(data, .16)));
  }

  // Continuous rustle while the reader holds the page.
  let beds = null;
  function dragStart(options = {}) {
    const t = { ...TURN_DEFAULTS, ...(typeof options === "boolean" ? { hard: options } : options) };
    const hard = t.hard;
    if (!ready() || drag) return;
    if (clips.length) {
      // The reader's own grab decides the pickup; the rustle then follows
      // the page live, and stops whenever the page is held still.
      // Only the small pickup as the corner is taken; the page then moves
      // silently until it lands.
      drag = { hard, quiet: true };
      if (!hard) pickup(ctx.currentTime + .005, { ...t, level: .8 });
      return;
    }
    beds ??= { soft: renderDragBed(false), hard: renderDragBed(true) };
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = hard ? beds.hard : beds.soft;
    source.loop = true;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = hard ? 1200 : 3000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(tone).connect(gain);
    gain.connect(master);
    gain.connect(room);
    source.start(now, Math.random() * 2);
    drag = { source, tone, gain, hard };
    if (!hard) peel();
  }

  // speed: pointer speed in px/ms. Faster drags are louder and brighter.
  function dragMove(input) {
    if (!drag || !ctx) return;
    const speed = typeof input === "number" ? input : input.speed;
    if (drag.quiet) return;
    const now = ctx.currentTime;
    const amount = clamp(Math.abs(speed) / 1.4, 0, 1);
    drag.gain.gain.setTargetAtTime((drag.hard ? .35 : .9) * amount ** .8, now, .04);
    drag.tone.frequency.setTargetAtTime((drag.hard ? 700 : 2200) + amount * (drag.hard ? 1500 : 9000), now, .05);
  }

  function dragEnd() {
    if (drag?.quiet) { drag = null; return; }
    if (!drag || !ctx) { drag = null; return; }
    const { source, gain } = drag;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0, now, .035);
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

  if (document.readyState === "complete") idle(loadRecordings);
  else window.addEventListener("load", () => idle(loadRecordings), { once: true });

  window.BookSound = {
    turn, peel, dragStart, dragMove, dragEnd, setMuted, unlock,
    get muted() { return muted; },
    get running() { return Boolean(ctx && ctx.state === "running"); },
    get recordings() { return clips.length; },
  };
})();
