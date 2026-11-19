"use strict";
/* ==========================================================================
   The Beginning of Forever: book engine
   --------------------------------------------------------------------------
   1. Layout      chooses a two-page spread or a single page for the viewport
                  and sets the page geometry as CSS variables.
   2. Paginate    flows the <template id="book-content"> sections onto pages
                  that fit the current page size (content decides page count).
   3. Leaves      binds pages into physical leaves (front + back) and covers.
   4. Turning     renders a soft paper fold or a rigid hardcover rotation.
   5. Navigation  buttons, keyboard, swipe/drag, corner clicks, TOC links,
                  and the URL hash so a refresh reopens the same page.
   ========================================================================== */

const book = document.getElementById("book");
const content = document.getElementById("book-content");
const progressLabel = document.getElementById("book-progress");
const prevButton = document.getElementById("book-previous");
const nextButton = document.getElementById("book-next");
const contentsButton = document.getElementById("book-contents");
const fullscreenButton = document.getElementById("book-fullscreen");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const coarsePointer = window.matchMedia("(pointer: coarse)");

const BOOK_TITLE = "The Beginning of Forever";
const LEGACY_HASHES = {
  "page-1": "introduction", "page-2": "chapter-3", "page-3": "chapter-3",
  "page-4": "letter-family", "page-5": "one-little-question",
};

const state = {
  mode: null, W: 0, H: 0,
  pages: [],       // interior pages: { el, section, first, folio, blockId }
  leaves: [],      // Leaf objects in binding order
  k: 0,            // how many leaves are turned to the left
  busy: 0,         // leaves currently in flight
  queued: 0,       // one pending turn requested while busy
  ready: false,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/* 1. Layout ---------------------------------------------------------------- */

function measureLayout() {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const controls = document.getElementById("book-controls").offsetHeight || 64;
  const small = vw < 600;
  // Leave room for the hardcover boards, which overhang the pages.
  const availH = vh - controls - (small ? 22 : 52);
  const availW = vw - (small ? 16 : 72);

  // A spread keeps true 6 × 9 proportions and is used only while both pages
  // stay comfortably readable.
  let H = Math.min(availH, 960);
  let W = Math.floor(H * 2 / 3);
  if (2 * W > availW) { W = Math.floor(availW / 2); H = Math.floor(W * 1.5); }
  const landscape = vw > vh;
  if (W >= 400 || (landscape && W >= 360)) {
    return { mode: "spread", W, H, fs: clamp(W / 24, 17, 19), ov: Math.round(clamp(H * .016, 8, 14)) };
  }

  // Single portrait page: phones may use a taller page so text gets room.
  // Short landscape screens (a phone on its side) get a wide page instead.
  W = Math.floor(Math.min(availW, 640, Math.max(availH / 1.5, availH < 500 ? 600 : 0)));
  if (availW < 520) W = Math.floor(availW);
  H = Math.floor(Math.min(availH, W * 1.85));
  return { mode: "single", W, H, fs: clamp(W / 21, 16, 18), ov: Math.round(clamp(W * .014, 4, 8)) };
}

function applyLayout(layout) {
  const root = document.documentElement.style;
  const small = layout.mode === "single" && layout.W < 520;
  root.setProperty("--page-w", `${layout.W}px`);
  root.setProperty("--page-h", `${layout.H}px`);
  root.setProperty("--fs", `${layout.fs.toFixed(2)}px`);
  root.setProperty("--ov", `${layout.ov}px`);
  root.setProperty("--pad-x", `${Math.round(small ? Math.max(20, layout.W * .07) : layout.W * .11)}px`);
  root.setProperty("--pad-top", `${Math.round(layout.H * (small ? .07 : .085))}px`);
  root.setProperty("--pad-bottom", `${Math.round(layout.H * (small ? .075 : .09))}px`);
  root.setProperty("--fold-r", `${layout.W + layout.H}px`);
  book.dataset.mode = layout.mode;
  Object.assign(state, { mode: layout.mode, W: layout.W, H: layout.H });
}

/* 2. Paginate -------------------------------------------------------------- */

// Prepare the source once: build the TOC and give every block a stable id.
const source = content.content.cloneNode(true);
const sections = [...source.children].filter((node) => node.classList.contains("book-section"));
const coverFront = source.querySelector('[data-cover="front"]');
const coverBack = source.querySelector('[data-cover="back"]');

(function buildContents() {
  const list = source.querySelector("[data-toc-list]");
  if (!list) return;
  const entries = [];
  const entry = (id, title, label, sub) => {
    const link = document.createElement("a");
    link.className = `toc-entry${sub ? " toc-entry--sub" : ""}`;
    link.href = `#${id}`;
    link.dataset.goto = id;
    link.innerHTML = `${label ? `<span class="toc-label">${label}</span>` : ""}`
      + `<span class="toc-title"></span><span class="toc-page" data-page-ref="${id}">–</span>`;
    link.querySelector(".toc-title").textContent = title;
    return link;
  };
  for (const section of sections) {
    if (!section.dataset.toc) continue;
    entries.push(entry(section.id, section.dataset.toc, section.dataset.label, false));
    section.querySelectorAll(".part-title[id]").forEach((part, index) => {
      const title = part.cloneNode(true);
      title.querySelector(".part-numeral")?.remove();
      const link = entry(part.id, title.textContent.trim(), "", true);
      if (index === 0) link.classList.add("toc-entry--first-sub");
      entries.push(link);
    });
  }
  list.replaceWith(...entries);
})();

let blockCounter = 0;
sections.forEach((section) => {
  [...section.children].forEach((block) => { block.dataset.b = `b${blockCounter++}`; });
});

const measureHost = document.createElement("div");
measureHost.className = "measure";
measureHost.setAttribute("aria-hidden", "true");
document.body.append(measureHost);

function createPage(section, first) {
  const el = document.createElement("div");
  el.className = "page";
  for (const name of section.classList) if (name !== "book-section") el.classList.add(`page--${name}`);
  if (first) el.classList.add("page--first");
  el.dataset.section = section.id;
  el.innerHTML = '<div class="page-head" aria-hidden="true"></div><div class="page-text"></div><div class="page-folio"></div>';
  measureHost.append(el);
  return { el, text: el.querySelector(".page-text"), section, first };
}

const overflows = (page) => page.text.scrollHeight > page.text.clientHeight + 1;

// Blocks are placed whole: a block that does not fit moves to a new page,
// taking any "keep with next" headings with it. Only a block taller than an
// entire page is left in place and allowed to scroll (never clipped).
function paginate() {
  measureHost.replaceChildren();
  const pages = [];
  for (const section of sections) {
    let page = createPage(section, true);
    pages.push(page);
    for (const original of section.children) {
      const block = original.cloneNode(true);
      const mustBreak = block.hasAttribute("data-break") || page.el.classList.contains("page--overflow");
      if (mustBreak && page.text.childElementCount) {
        page = createPage(section, false);
        pages.push(page);
      }
      page.text.append(block);
      if (!overflows(page)) continue;

      const carry = [block];
      block.remove();
      while (page.text.lastElementChild?.hasAttribute("data-keep-next")) {
        const heading = page.text.lastElementChild;
        heading.remove();
        carry.unshift(heading);
      }
      if (!page.text.childElementCount) {
        page.text.append(...carry);
        page.el.classList.add("page--overflow");
        continue;
      }
      page = createPage(section, false);
      pages.push(page);
      page.text.append(...carry);
      if (overflows(page)) page.el.classList.add("page--overflow");
    }
  }

  // Folios, anchors and cross-references (TOC + "read it in my letter").
  const anchorFolio = new Map();
  pages.forEach((page, index) => {
    page.folio = index + 1;
    page.blockId = page.text.firstElementChild?.dataset.b || "";
    page.el.querySelector(".page-folio").textContent = page.folio;
    if (page.first) anchorFolio.set(page.section.id, page.folio);
    page.el.querySelectorAll("[id]").forEach((node) => {
      if (!anchorFolio.has(node.id)) anchorFolio.set(node.id, page.folio);
    });
  });
  pages.forEach((page) => {
    page.el.querySelectorAll("[data-page-ref]").forEach((ref) => {
      ref.textContent = anchorFolio.get(ref.dataset.pageRef) ?? "–";
    });
  });
  state.anchorFolio = anchorFolio;
  return pages;
}

/* 3. Leaves ---------------------------------------------------------------- */

function boardFace(kind) {
  if (kind === "cover-front" || kind === "cover-back") {
    const face = document.createElement("div");
    face.className = `cover-face${kind === "cover-back" ? " cover-face--back" : ""}`;
    face.append((kind === "cover-front" ? coverFront : coverBack).cloneNode(true));
    return face;
  }
  const inside = document.createElement("div");
  inside.className = `board-inside${kind === "inside-back" ? " board-inside--back" : ""}`;
  inside.innerHTML = '<div class="endpaper"></div>';
  return inside;
}

function blankPage() {
  const el = document.createElement("div");
  el.className = "page page--blank";
  return el;
}

class Leaf {
  constructor(front, back, hard) {
    this.front = front;   // { kind, page? , el }
    this.back = back;
    this.hard = hard;
    this.turned = false;
    this.flying = false;
    this.el = document.createElement("div");
    this.el.className = `leaf leaf--${hard ? "hard" : "soft"}`;
    this.frontFace = this.face("front", front.el);
    if (hard) {
      this.backFace = this.face("back", back.el);
      this.frontShade = this.shade(this.frontFace, "hard-shade");
      this.backShade = this.shade(this.backFace, "hard-shade");
      this.el.append(this.frontFace, this.backFace);
    } else {
      this.foldShade = this.shade(this.frontFace, "fold-shade");
      const cast = document.createElement("div");
      cast.className = "leaf-cast";
      this.castStrip = this.shade(cast, "cast-strip");
      this.flap = document.createElement("div");
      this.flap.className = "leaf-flap";
      this.backFace = this.face("back", back.el);
      this.foldLight = this.shade(this.backFace, "fold-light");
      this.flap.append(this.backFace);
      this.el.append(this.frontFace, cast, this.flap);
    }
  }

  face(side, child) {
    const face = document.createElement("div");
    face.className = `leaf-face leaf-face--${side}`;
    face.append(child);
    return face;
  }

  shade(parent, className) {
    const shade = document.createElement("div");
    shade.className = className;
    shade.setAttribute("aria-hidden", "true");
    parent.append(shade);
    return shade;
  }
}

function buildBook(pages) {
  const spread = state.mode === "spread";
  const faces = [];
  const pageFace = (page, side) => {
    page.el.classList.remove("page--recto", "page--verso", "page--single");
    page.el.classList.add(`page--${side}`);
    page.el.querySelector(".page-head").textContent = side === "verso" ? BOOK_TITLE : page.section.dataset.title;
    return { kind: "page", page, el: page.el };
  };

  const leaves = [];
  if (spread) {
    // cover | inside-front, p1 | p2, p3 | p4 ..., inside-back | back cover
    faces.push({ kind: "cover-front", el: boardFace("cover-front") }, { kind: "inside-front", el: boardFace("inside-front") });
    pages.forEach((page, index) => faces.push(pageFace(page, index % 2 === 0 ? "recto" : "verso")));
    if (pages.length % 2) faces.push({ kind: "blank", el: blankPage() });
    faces.push({ kind: "inside-back", el: boardFace("inside-back") }, { kind: "cover-back", el: boardFace("cover-back") });
    for (let i = 0; i < faces.length; i += 2) {
      const hard = i === 0 || i === faces.length - 2;
      leaves.push(new Leaf(faces[i], faces[i + 1], hard));
    }
  } else {
    // One page per leaf; the reverse of each sheet is plain paper.
    leaves.push(new Leaf({ kind: "cover-front", el: boardFace("cover-front") }, { kind: "inside-front", el: boardFace("inside-front") }, true));
    pages.forEach((page) => {
      const front = pageFace(page, "single");
      // Thin book paper lets the printing show faintly through its reverse.
      const reverse = document.createElement("div");
      reverse.className = "paper-back";
      const ghost = page.el.cloneNode(true);
      ghost.classList.add("page--ghost");
      ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      reverse.append(ghost);
      leaves.push(new Leaf(front, { kind: "reverse", el: reverse }, false));
    });
    // Turning the last page closes the book onto its back cover.
    leaves.push(new Leaf({ kind: "cover-back", el: boardFace("cover-back") }, { kind: "inside-back", el: boardFace("inside-back") }, true));
  }

  const crease = document.createElement("div");
  crease.className = "book-crease";
  const edgeLeft = document.createElement("div");
  edgeLeft.className = "book-edge book-edge--left";
  const edgeRight = document.createElement("div");
  edgeRight.className = "book-edge book-edge--right";
  book.replaceChildren(...leaves.map((leaf) => leaf.el), crease, edgeLeft, edgeRight);
  Object.assign(state, { leaves, crease, edgeLeft, edgeRight });
}

const maxK = () => (state.mode === "spread" ? state.leaves.length : state.leaves.length - 1);

// Which leaf position (k) shows a given interior page index.
function kForPage(index) {
  if (state.mode === "single") return index + 1;
  const seq = index + 2;            // after cover + inside-front
  return seq % 2 === 0 ? seq / 2 : (seq + 1) / 2;
}

/* 4. Turning --------------------------------------------------------------- */

// Keep only the part of a polygon where a*x + b*y + c >= 0.
function clipPolygon(points, a, b, c) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const dp = a * p[0] + b * p[1] + c;
    const dq = a * q[0] + b * q[1] + c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}
const polygon = (points) => `polygon(${points.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(",")})`;

function placeShade(el, x, y, angle, opacity) {
  const r = state.W + state.H;
  el.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad) translateY(${-r}px)`;
  el.style.opacity = opacity;
}

// A page is held by the spine, so its loose corner can only travel within a
// circle of radius W around the spine corner on the same edge, and within the
// page diagonal from the opposite spine corner.
function constrainCorner(point, cy) {
  const { W, H } = state;
  let { x, y } = point;
  const near = { x: 0, y: cy };
  const far = { x: 0, y: H - cy };
  const diagonal = Math.hypot(W, H);
  let d = Math.hypot(x - near.x, y - near.y);
  if (d > W) { x = near.x + (x - near.x) * W / d; y = near.y + (y - near.y) * W / d; }
  d = Math.hypot(x - far.x, y - far.y);
  if (d > diagonal) { x = far.x + (x - far.x) * diagonal / d; y = far.y + (y - far.y) * diagonal / d; }
  return { x, y };
}

/*
  Soft paper fold, in page coordinates (spine at x = 0, page width W).
  The loose corner C = (W, cy) is dragged to P. The fold line is the
  perpendicular bisector of C→P, with unit normal n pointing from C to P.
  - Front face: keeps the half-plane on P's side, (X − M)·n ≥ 0.
  - Back face: the part that was folded over, mirrored across the fold line.
    The back is a mirror image of the front, so "mirror the page, then
    reflect across the fold" is a plain rotation + translation:
      matrix(2nx² − 1, 2nx·ny, −2nx·ny, 1 − 2ny², e, f)
*/
function renderFold(leaf, point, cy) {
  const { W, H } = state;
  const P = constrainCorner(point, cy);
  const dx = P.x - W;
  const dy = P.y - cy;
  const length = Math.hypot(dx, dy);
  if (length < .5) { setRest(leaf, false); leaf.pose = { P, cy }; return; }

  const nx = dx / length;
  const ny = dy / length;
  const mx = (P.x + W) / 2;
  const my = (P.y + cy) / 2;
  const md = mx * nx + my * ny;
  const rect = [[0, 0], [W, 0], [W, H], [0, H]];

  const frontPoly = clipPolygon(rect, nx, ny, -md);
  const backPoly = clipPolygon(rect, nx, -ny, -(W - mx) * nx + my * ny);

  leaf.frontFace.style.visibility = frontPoly.length > 2 ? "" : "hidden";
  leaf.frontFace.style.clipPath = polygon(frontPoly.length > 2 ? frontPoly : [[0, 0], [0, 0], [0, 0]]);
  leaf.flap.style.visibility = backPoly.length > 2 ? "visible" : "hidden";
  leaf.backFace.style.clipPath = polygon(backPoly.length > 2 ? backPoly : [[0, 0], [0, 0], [0, 0]]);
  const e = W * (1 - 2 * nx * nx) + 2 * md * nx;
  const f = -2 * W * nx * ny + 2 * md * ny;
  leaf.backFace.style.transform = `matrix(${2 * nx * nx - 1}, ${2 * nx * ny}, ${-2 * nx * ny}, ${1 - 2 * ny * ny}, ${e}, ${f})`;

  // Lighting: strongest mid-turn, fading as the page lies flat again.
  const progress = clamp((W - P.x) / (2 * W), 0, 1);
  const depth = Math.sin(progress * Math.PI) ** .6;
  leaf.el.style.setProperty("--flap", `${Math.max(40, length / 2)}px`);
  placeShade(leaf.foldShade, mx, my, Math.atan2(ny, nx), depth);
  placeShade(leaf.foldLight, W - mx, my, Math.atan2(-ny, nx), .55 + depth * .45);
  placeShade(leaf.castStrip, mx, my, Math.atan2(-ny, -nx), depth);
  leaf.pose = { P, cy };
}

function renderHard(leaf, t) {
  leaf.el.style.transform = `rotateY(${(-180 * t).toFixed(3)}deg)`;
  leaf.frontShade.style.opacity = (Math.min(1, t * 2) * .45).toFixed(3);
  leaf.backShade.style.opacity = (Math.min(1, (1 - t) * 2) * .45).toFixed(3);
  leaf.pose = { t };
}

function setRest(leaf, turned) {
  leaf.turned = turned;
  leaf.pose = null;
  if (leaf.hard) {
    leaf.el.style.transform = turned ? "rotateY(-180deg)" : "";
    leaf.frontShade.style.opacity = 0;
    leaf.backShade.style.opacity = 0;
    return;
  }
  leaf.frontFace.style.clipPath = "";
  leaf.frontFace.style.visibility = turned ? "hidden" : "";
  leaf.flap.style.visibility = turned ? "visible" : "hidden";
  leaf.backFace.style.clipPath = "";
  leaf.backFace.style.transform = turned ? `translateX(${-state.W}px)` : "";
  for (const shade of [leaf.foldShade, leaf.foldLight, leaf.castStrip]) shade.style.opacity = 0;
}

function tween(duration, ease, step) {
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now) => {
      const t = clamp((now - start) / duration, 0, 1);
      step(ease(t));
      if (t < 1) window.requestAnimationFrame(frame);
      else resolve();
    };
    window.requestAnimationFrame(frame);
  });
}

function beginFlight(leaf, priority) {
  leaf.flying = true;
  leaf.el.classList.remove("is-far");
  leaf.el.classList.add("is-turning");
  leaf.el.style.zIndex = String(state.leaves.length + 10 + priority);
}

function endFlight(leaf, turned) {
  setRest(leaf, turned);
  leaf.flying = false;
  leaf.el.classList.remove("is-turning");
}

/*
  The physical situation of a turn, passed to the sound engine so each
  turn sounds the way that particular page would: where in the book it is,
  how thick the stack it lands on is, which corner was taken and how fast.
*/
function turnContext(leaf, toTurned, extra = {}) {
  const soft = state.leaves.filter((item) => !item.hard);
  const total = Math.max(1, soft.length);
  const index = state.leaves.indexOf(leaf);
  const turnedOthers = soft.filter((item) => item.turned && item !== leaf).length;
  const landingStack = toTurned ? turnedOthers : total - turnedOthers - 1;
  return {
    forward: toTurned,
    depth: index / Math.max(1, state.leaves.length - 1),
    stack: clamp(landingStack / total, 0, 1),
    spread: state.mode === "spread",
    corner: leaf.grab?.corner ?? "bottom",
    grabY: leaf.grab?.y ?? .9,
    bend: leaf.grab?.bend ?? .35,
    ...extra,
  };
}

/*
  Animate one leaf to its turned (toTurned = true) or flat state, starting
  from its current pose (e.g. where a drag was released). Soft pages travel
  along a gentle arc so the corner lifts as it crosses the spine.
*/
async function animateLeaf(leaf, toTurned, { duration, ease = easeInOut, priority = 0, sound = 1, motion = {} } = {}) {
  state.busy += 1;
  beginFlight(leaf, priority);
  const { W, H } = state;
  if (leaf.hard) {
    const from = leaf.pose?.t ?? (leaf.turned ? 1 : 0);
    const to = toTurned ? 1 : 0;
    const time = duration ?? 1050 * Math.max(.35, Math.abs(to - from));
    window.BookSound?.turn({ duration: time / 1000, hard: true, level: sound, ...turnContext(leaf, toTurned, motion) });
    await tween(time, ease, (e) => renderHard(leaf, from + (to - from) * e));
  } else {
    const cy = leaf.pose?.cy ?? H;
    const start = leaf.pose?.P ?? { x: leaf.turned ? -W : W, y: cy };
    const endX = toTurned ? -W : W;
    const fresh = !leaf.pose;
    const lift = H * .14 * (cy === 0 ? -1 : 1);
    const share = Math.abs(endX - start.x) / (2 * W);
    const time = duration ?? 850 * Math.max(.35, share);
    window.BookSound?.turn({
      duration: time / 1000, level: sound, lifted: fresh,
      ...turnContext(leaf, toTurned, {
        // Page widths per second, normalised: a button turn is ~0.65, a flick ~1.
        pace: clamp((2 * share) / (time / 1000) / 3.5, .15, 1),
        curve: ease === easeOut ? "out" : "inout",
        ...motion,
      }),
    });
    await tween(time, ease, (e) => {
      const arc = fresh ? Math.sin(Math.PI * e) * lift : 0;
      renderFold(leaf, { x: start.x + (endX - start.x) * e, y: start.y + (cy - start.y) * e - arc }, cy);
    });
  }
  endFlight(leaf, toTurned);
  state.busy -= 1;
}

/* 5. Navigation ------------------------------------------------------------ */

function restack() {
  const { leaves, k } = state;
  const count = leaves.length;
  leaves.forEach((leaf, index) => {
    if (leaf.flying) return;
    leaf.el.style.zIndex = String(leaf.turned ? index + 1 : count - index);
    // Only the nearby leaves need painting; boards always show under the stacks.
    const near = leaf.pending || (index >= k - 2 && index <= k + 1);
    // display:none (not visibility) so the flap's own visibility can't leak through.
    const offscreen = state.mode === "single" && leaf.turned;
    leaf.el.classList.toggle("is-far", offscreen || (!near && !leaf.hard));
  });
  state.crease.style.zIndex = String(count + 2);
  state.edgeLeft.style.zIndex = state.edgeRight.style.zIndex = String(count + 2);
}

function updateChrome() {
  const { leaves, k, mode } = state;
  const spread = mode === "spread";
  // Only the faces on show can take focus or be read by assistive tech.
  leaves.forEach((leaf, index) => {
    const frontVisible = !leaf.turned && index === k;
    const backVisible = spread && leaf.turned && index === k - 1;
    leaf.frontFace.inert = !frontVisible;
    leaf.backFace.inert = !backVisible;
    leaf.frontFace.setAttribute("aria-hidden", String(!frontVisible));
    leaf.backFace.setAttribute("aria-hidden", String(!backVisible));
  });

  book.classList.toggle("is-closed-front", k === 0);
  book.classList.toggle("is-closed-back", k === maxK());

  const softLeaves = leaves.filter((leaf) => !leaf.hard);
  const turnedSoft = softLeaves.filter((leaf) => leaf.turned).length;
  const edge = (count) => `${Math.round(clamp(count * .45, count ? 1 : 0, spread ? 9 : 4))}px`;
  state.edgeLeft.style.setProperty("--edge", edge(turnedSoft));
  state.edgeRight.style.setProperty("--edge", edge(softLeaves.length - turnedSoft - (spread ? 0 : 1)));

  const visible = visiblePages();
  const total = state.pages.length;
  let label = "Cover";
  const compact = window.innerWidth < 420;
  if (visible.length === 2) label = `Pages ${visible[0].folio}–${visible[1].folio} of ${total}`;
  else if (visible.length === 1) label = compact ? `${visible[0].folio} / ${total}` : `Page ${visible[0].folio} of ${total}`;
  else if (k > 0) label = "The End";
  progressLabel.textContent = label;
  prevButton.disabled = k <= 0;
  nextButton.disabled = k >= maxK();
}

function visiblePages() {
  const { leaves, k } = state;
  const faces = state.mode === "spread"
    ? [leaves[k - 1]?.back, leaves[k]?.front]
    : [leaves[k]?.front];
  return faces.filter((face) => face?.kind === "page").map((face) => face.page);
}

function currentAnchor() {
  const { k } = state;
  if (k === 0) return "";
  const pages = visiblePages();
  if (!pages.length) return k >= maxK() ? "end" : "";
  const page = pages[pages.length - 1];
  return page.first ? page.section.id : `at-${page.blockId}`;
}

function rememberPosition() {
  const anchor = currentAnchor();
  const url = anchor ? `#${anchor}` : `${window.location.pathname}${window.location.search}`;
  if (`#${anchor}` !== window.location.hash || !anchor) window.history.replaceState(null, "", url);
}

function settle() {
  restack();
  updateChrome();
  rememberPosition();
  if (state.queued && !state.busy) {
    const direction = state.queued;
    state.queued = 0;
    turnTo(state.k + direction);
  }
}

// Resolve an anchor (section id, element id, "at-<block>", or legacy hash).
function kForAnchor(rawAnchor) {
  let anchor = decodeURIComponent(rawAnchor || "").replace(/^#/, "");
  anchor = LEGACY_HASHES[anchor] || anchor;
  if (!anchor) return 0;
  if (anchor === "end") return maxK();
  const pages = state.pages;
  let index = -1;
  if (anchor.startsWith("at-")) {
    const block = anchor.slice(3);
    index = pages.findIndex((page) => page.el.querySelector(`.page-text > [data-b="${block}"]`));
  } else if (state.anchorFolio.has(anchor)) {
    index = state.anchorFolio.get(anchor) - 1;
  }
  return index < 0 ? null : kForPage(index);
}

// Jump to leaf position `target`. Neighbouring pages turn normally; longer
// jumps riffle through the last few leaves so the reader sees the book move.
async function turnTo(target) {
  if (!state.ready) return;
  target = clamp(target, 0, maxK());
  if (target === state.k) return;
  if (state.busy) { state.queued = Math.sign(target - state.k); return; }

  const forward = target > state.k;
  const order = [];
  if (forward) for (let i = state.k; i < target; i += 1) order.push(i);
  else for (let i = state.k - 1; i >= target; i -= 1) order.push(i);

  state.k = target;
  updateChrome();

  if (reduceMotion.matches) {
    order.forEach((i) => setRest(state.leaves[i], forward));
    book.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    window.BookSound?.turn({ duration: .25, level: .5 });
    settle();
    return;
  }

  const MAX_ANIMATED = 7;
  const instant = order.splice(0, Math.max(0, order.length - MAX_ANIMATED));
  instant.forEach((i) => setRest(state.leaves[i], forward));
  // Leaves still waiting their turn in a riffle must stay painted.
  order.forEach((i) => { state.leaves[i].pending = true; });
  restack();
  const riffle = order.length > 1;
  await Promise.all(order.map((i, n) => wait(n * (riffle ? 140 : 0)).then(() => animateLeaf(state.leaves[i], forward, {
    duration: riffle ? (state.leaves[i].hard ? 800 : 620) : undefined,
    priority: order.length - n,
    ease: easeInOut,
    sound: riffle ? .55 : 1,
  }).then(() => { state.leaves[i].pending = false; }))));
  settle();
}

// In a spread, an odd page count leaves the last page's reverse blank. That
// empty opening is skipped: turning the final page closes the book.
function isBlankEnd(k) {
  return state.mode === "spread" && k === state.leaves.length - 1 && state.leaves[k - 1]?.back.kind === "blank";
}

function go(direction) {
  if (direction > 0 && state.k === 0) requestReaderFullscreen();
  let target = state.k + direction;
  if (isBlankEnd(target)) target += direction;
  turnTo(target);
}

function goToAnchor(anchor) {
  const target = kForAnchor(anchor);
  if (target !== null) turnTo(target);
}

prevButton.addEventListener("click", () => go(-1));
nextButton.addEventListener("click", () => go(1));
contentsButton.addEventListener("click", () => goToAnchor("contents"));

document.addEventListener("keydown", (event) => {
  const tip = document.getElementById("install-tip");
  if (tip && !tip.hidden) {
    if (event.key === "Escape") { event.preventDefault(); tip.querySelector("button")?.click(); }
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  const keys = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 };
  if (keys[event.key]) { event.preventDefault(); go(keys[event.key]); }
  else if (event.key === "Home") { event.preventDefault(); turnTo(0); }
  else if (event.key === "End") { event.preventDefault(); turnTo(maxK()); }
});

// Links inside the book (contents, promise cross-references) turn pages.
book.addEventListener("click", (event) => {
  const link = event.target.closest("[data-goto]");
  if (link) { event.preventDefault(); goToAnchor(link.dataset.goto); return; }
  if (event.target.closest("#proposal-accept-yes")) window.location.assign(new URL("./accepted.html", window.location.href).href);
  else if (event.target.closest("#noButton")) window.location.assign(new URL("./no.html", window.location.href).href);
});

window.addEventListener("hashchange", () => {
  if (window.location.hash.slice(1) !== currentAnchor()) goToAnchor(window.location.hash);
});

/* Drag, swipe, corner peel ------------------------------------------------- */

const interactive = (target) => target instanceof Element
  && target.closest("button, a, input, textarea, select, [role='button']");

// Pointer position in the coordinates of the right-hand (or single) page.
function pagePoint(event) {
  const rect = book.getBoundingClientRect();
  const offset = state.mode === "spread" ? state.W : 0;
  return { x: event.clientX - rect.left - offset, y: event.clientY - rect.top };
}

let drag = null;
let peel = null;

function cornerZone(point) {
  const { W, H, k } = state;
  const size = Math.min(90, W * .2);
  if (point.y < H - size * 1.4 || point.y > H + 4) return 0;
  if (point.x > W - size && point.x < W + 6 && k < maxK()) return 1;
  if (state.mode === "spread" && point.x < -W + size && point.x > -W - 6 && k > 0) return -1;
  return 0;
}

function setPeel(direction) {
  if (peel?.direction === direction) return;
  if (peel) { const old = peel.leaf; if (!old.flying) setRest(old, old.turned); old.el.style.zIndex = ""; restack(); }
  peel = null;
  if (!direction || state.busy) return;
  const leaf = state.leaves[direction > 0 ? state.k : state.k - 1];
  if (!leaf) return;
  peel = { direction, leaf };
  leaf.el.style.zIndex = String(state.leaves.length + 5);
  const lift = Math.min(70, state.W * .14);
  if (leaf.hard) renderHard(leaf, direction > 0 ? .035 : .965);
  else renderFold(leaf, { x: direction > 0 ? state.W - lift : -state.W + lift, y: state.H - lift * .7 }, state.H);
  window.BookSound?.peel();
}

// A drag may start anywhere, even on a link (the contents page is mostly
// links); the click that would follow a real drag is swallowed below.
let suppressClick = false;
book.addEventListener("click", (event) => {
  if (!suppressClick) return;
  suppressClick = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

book.addEventListener("pointerdown", (event) => {
  if (!state.ready || state.busy || !event.isPrimary) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  suppressClick = false;
  drag = {
    id: event.pointerId, x0: event.clientX, y0: event.clientY, start: pagePoint(event),
    started: false, samples: [], onControl: Boolean(interactive(event.target)),
  };
});

book.addEventListener("pointermove", (event) => {
  if (!drag) {
    if (event.pointerType === "mouse" && state.ready) setPeel(cornerZone(pagePoint(event)));
    return;
  }
  if (event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x0;
  const dy = event.clientY - drag.y0;
  if (!drag.started) {
    // Wait for a clearly horizontal gesture so vertical scrolling still works.
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) {
      if (Math.abs(dy) > 16) drag = null;
      return;
    }
    const forward = dx < 0;
    const index = forward ? state.k : state.k - 1;
    if (forward ? state.k >= maxK() : state.k <= 0) { drag = null; return; }
    const leaf = state.leaves[index];
    if (peel?.leaf !== leaf) setPeel(0);
    peel = null;
    if (forward && state.k === 0) requestReaderFullscreen();
    Object.assign(drag, { started: true, forward, leaf, cy: drag.start.y < state.H / 2 ? 0 : state.H });
    beginFlight(leaf, 0);
    state.busy += 1;
    leaf.grab = {
      corner: drag.cy === 0 ? "top" : "bottom",
      y: clamp(drag.start.y / state.H, 0, 1),
      bend: .2,
    };
    window.BookSound?.dragStart({ hard: leaf.hard, ...turnContext(leaf, forward) });
    try { book.setPointerCapture(event.pointerId); } catch { /* optional */ }
  }
  drag.samples.push({ x: event.clientX, t: event.timeStamp });
  if (drag.samples.length > 6) drag.samples.shift();
  const recent = drag.samples.slice(-3);
  if (recent.length > 1) {
    // The rustle follows how fast the page is moving.
    const span = recent[recent.length - 1].t - recent[0].t;
    // Bend grows as the corner is lifted away from its edge.
    const grab = drag.leaf.grab;
    if (grab) grab.bend = clamp(.2 + Math.abs(event.clientY - drag.y0) / (state.H * .35), .2, 1);
    window.BookSound?.dragMove({
      speed: (recent[recent.length - 1].x - recent[0].x) / Math.max(8, span),
      bend: grab?.bend ?? .3,
    });
  }
  const { W } = state;
  const { leaf, forward } = drag;
  if (leaf.hard) {
    const span = state.mode === "spread" ? W * 1.4 : W * .9;
    renderHard(leaf, clamp(forward ? -dx / span : 1 - dx / span, 0, 1));
  } else {
    const gain = state.mode === "spread" ? 1.25 : 2.1;
    renderFold(leaf, { x: (forward ? W : -W) + dx * gain, y: drag.cy + dy * .5 }, drag.cy);
  }
});

async function endDrag(event, cancelled) {
  if (!drag || (event && event.pointerId !== drag.id)) return;
  const current = drag;
  drag = null;
  if (!current.started) {
    if (cancelled || !event || current.onControl) return;
    // A tap: open the closed cover, or turn from a page corner.
    const point = pagePoint(event);
    const zone = cornerZone(point);
    if (zone) { peel = null; go(zone); }
    else if (state.k === 0 && point.x >= 0 && point.x <= state.W) go(1);
    else if (state.mode === "spread" && state.k === maxK() && point.x < 0) go(-1);
    return;
  }

  suppressClick = true;
  window.setTimeout(() => { suppressClick = false; }, 0);
  const { leaf, forward } = current;
  const samples = current.samples;
  const velocity = samples.length > 1
    ? (samples[samples.length - 1].x - samples[0].x) / Math.max(1, samples[samples.length - 1].t - samples[0].t)
    : 0;
  const progress = leaf.hard ? (leaf.pose?.t ?? 0) : clamp((state.W - (leaf.pose?.P.x ?? state.W)) / (2 * state.W), 0, 1);
  const flick = forward ? velocity < -.45 : velocity > .45;
  const complete = !cancelled && (flick || (forward ? progress > .3 : progress < .7));
  const toTurned = forward ? complete : !complete;
  state.busy -= 1;
  if (complete) state.k += forward ? 1 : -1;
  updateChrome();
  window.BookSound?.dragEnd();
  // A page let go early falls back with a softer sound.
  await animateLeaf(leaf, toTurned, {
    ease: easeOut, priority: 0, sound: complete ? .85 : .5,
    motion: { pace: clamp(Math.abs(velocity) / 1.4, .25, 1), snapBack: !complete },
  });
  leaf.grab = null;
  settle();
  if (complete && isBlankEnd(state.k)) turnTo(state.k + (forward ? 1 : -1));
}

book.addEventListener("pointerup", (event) => endDrag(event, false));
book.addEventListener("pointercancel", (event) => endDrag(event, true));
book.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse" && !drag) setPeel(0); });

/* Sound toggle ------------------------------------------------------------- */

const soundButton = document.getElementById("book-sound");
function syncSoundButton() {
  const on = !window.BookSound?.muted;
  soundButton.setAttribute("aria-pressed", String(on));
  soundButton.setAttribute("aria-label", on ? "Sound on. Turn page sounds off" : "Sound off. Turn page sounds on");
  soundButton.classList.toggle("is-muted", !on);
}
if (soundButton && window.BookSound) {
  soundButton.hidden = false;
  syncSoundButton();
  soundButton.addEventListener("click", () => {
    window.BookSound.unlock();
    window.BookSound.setMuted(!window.BookSound.muted);
    syncSoundButton();
  });
}

/* Fullscreen --------------------------------------------------------------- */

const fullscreenSupported = Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
let autoFullscreenTried = false;

function enterFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  try { request?.call(root)?.catch?.(() => {}); } catch { /* not allowed */ }
}

// On phones, opening the cover (a user gesture) also enters fullscreen once.
function requestReaderFullscreen() {
  if (autoFullscreenTried || !coarsePointer.matches) return;
  autoFullscreenTried = true;
  if (fullscreenSupported) {
    if (!fullscreenElement()) enterFullscreen();
    return;
  }
  // iPhone: offer the Home Screen route once, the first time the book opens.
  let seen = false;
  try { seen = window.localStorage.getItem("book-install-tip") === "seen"; } catch { /* storage unavailable */ }
  if (iPhoneSafari && !seen) window.setTimeout(showInstallTip, 1200);
}

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
const runningAsApp = window.navigator.standalone === true
  || window.matchMedia("(display-mode: standalone)").matches
  || window.matchMedia("(display-mode: fullscreen)").matches;
// iPhone Safari cannot put a page in full screen; saving the book to the
// Home Screen is the only way, so the button explains how instead.
const iPhoneSafari = /iPhone|iPod/.test(navigator.userAgent) && !fullscreenSupported && !runningAsApp;
document.documentElement.classList.toggle("is-iphone-safari", iPhoneSafari);

const installTip = document.getElementById("install-tip");
const installTipClose = document.getElementById("install-tip-close");
let tipReturnFocus = null;

function showInstallTip() {
  if (!installTip) return;
  tipReturnFocus = document.activeElement;
  installTip.hidden = false;
  installTipClose?.focus();
  try { window.localStorage.setItem("book-install-tip", "seen"); } catch { /* storage unavailable */ }
}

function hideInstallTip() {
  if (!installTip || installTip.hidden) return;
  installTip.hidden = true;
  tipReturnFocus?.focus?.();
}

installTipClose?.addEventListener("click", hideInstallTip);
installTip?.addEventListener("click", (event) => { if (event.target === installTip) hideInstallTip(); });

if (fullscreenButton && !runningAsApp && (fullscreenSupported || iPhoneSafari)) {
  fullscreenButton.hidden = false;
  if (iPhoneSafari) fullscreenButton.setAttribute("aria-label", "How to read in full screen");
  fullscreenButton.addEventListener("click", () => {
    if (iPhoneSafari) { showInstallTip(); return; }
    if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    else enterFullscreen();
  });
}

/* Start-up and responsive relayout ----------------------------------------- */

function layoutBook(anchor) {
  const layout = measureLayout();
  applyLayout(layout);
  state.pages = paginate();
  buildBook(state.pages);
  const target = anchor === undefined ? 0 : kForAnchor(anchor) ?? 0;
  state.k = clamp(target, 0, maxK());
  state.leaves.forEach((leaf, index) => setRest(leaf, index < state.k));
  state.layoutKey = `${layout.mode}:${layout.W}x${layout.H}`;
  state.ready = true;
  restack();
  updateChrome();
}

function relayout() {
  if (!state.ready) return;
  if (state.busy || drag) { window.setTimeout(relayout, 250); return; }
  const layout = measureLayout();
  const key = `${layout.mode}:${layout.W}x${layout.H}`;
  if (key === state.layoutKey) return;
  setPeel(0);
  // Keep the reader on the same words, whatever the new page size.
  const anchor = currentAnchor() || (state.k > 0 ? "end" : "");
  layoutBook(anchor);
  rememberPosition();
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(relayout, 160);
});

function start() {
  if (state.ready) return;
  layoutBook(window.location.hash);
  book.classList.add("is-ready");
  rememberPosition();
  // Pages are measured with the final fonts; re-measure if any arrive late.
  document.fonts?.addEventListener?.("loadingdone", () => { state.layoutKey = ""; relayout(); });
}

if (document.fonts?.ready) {
  Promise.race([document.fonts.ready, wait(2500)]).then(start);
} else {
  start();
}

// Small inspection hook for automated checks; has no effect on reading.
window.bookReader = { state, turnTo, go, goToAnchor, kForAnchor };
