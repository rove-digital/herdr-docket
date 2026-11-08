// The Docket layout's bottom dock. One mod, three rows, chosen by props().part:
//   "tabs":   the shown space's tabs (a status dot per pane, program icon, name, time; compact
//             when they don't fit), +, then changes / files / search / machine / settings /
//             collapse on the right.
//   "spaces": a dotted rule along the top, then spaces grouped by machine (this computer first,
//             then each machine by name, shown even with no spaces): status dots, the space's
//             number, its name, and a + per group for a new space there.
//   "agents": the ruler, then every agent on every machine (helpers too) as flags hanging
//             from it, until it closes, and the HERDR wordmark on the right. A new agent
//             slides in from the left and bumps the others along; once placed, they keep their
//             order. Clicking a flag opens its pane; the focused pane's agent is outlined.
// Collapsing the dock hides the spaces and agents rows; the tabs row stays.
// Every colour is a theme token from theme(): the layout's own theme (Docket-Sunset) unless the
// person picks another, which the dock then follows. Shades are mixed from tokens, never hex.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, spaces, machines, panes, focused, run, shared, setShared, setAgentOrder, openOverlay, props, layout, theme, nextCommand } from "herdr";

const ICON = (n) => `mods/docket/${n}.svg`;

// Sizes from the mockup (4570 px wide), at a 2560 px window.
const STRIP = 12;        // ruler strip, tabs-row colour
const CARET = 7;         // flag arrow height
const FW = 41;           // flag width
const FH = 56;           // flag body height
const GAP = 3;           // between flags
const BP = 3;            // a flag's block pixel: its outline, drop shadow and corner steps
const LEFT = 18;         // where the stack starts: the first flag sits under the computer icon
// The ruler: a tall mark under every flag slot's arrow, 3 short ticks between. Flags step
// FW + GAP = 44 px, so ticks are 11 px apart; when flags close up, the ruler does too.
const TICKS = 4;
const ANCHOR = LEFT + Math.floor(FW / 2); // the ruler's tall mark over the first flag's arrow
const WHEEL = 40;        // px of scroll per tab step
// Motion. Newcomers slide in from past the left edge (fully shown, no fade), starting fast
// and slowing as they settle (ease-out), one after another, and the flags already there move
// along to make room straight away, in a ripple. When one closes, it fades out where it stood
// and the flags after it close up.
const ENTER = { duration: 600, easing: "ease-out" };
const SHIFT = { duration: 380, easing: "ease-out" };
const FADE_OUT = { duration: 300, easing: "ease-in-out" };
const ADMIT = 280;       // ms between newcomers when several arrive together: each comes on alone
const RIPPLE = 35;       // ms between flags moving along
const FLAG_SHADE = 0.3;  // how much darker a flag's bottom band is, 0 to 1
const EDGE_RIGHT = 14;   // the wordmark sits this far in from the bar's right edge, px
const TAB_H = 54;        // a tab's height, centred in the taller tabs row
const SP_PAD = 12;       // a space's side padding: half the 24 px between spaces
const SP_NUM = 16;       // a space's number square, px
const SP_TOP = 8;        // extra room between the dotted line and the spaces (the layout's row grows by as much)
const FLASH = new Set(["blocked", "working"]); // flags that flash
const FLASH_LOOP = { from: 0, to: 0.2, period: 2400 }; // a dark wash over face and icon, on one beat
const KNOWN = new Set(["working", "blocked", "done", "idle"]);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const collapsed = () => Boolean(find(layout(), "docket-agents")?.hidden);
function toggleDock() {
  const cmd = collapsed() ? "layout.show" : "layout.hide";
  for (const id of ["docket-spaces", "docket-agents"]) run(cmd, { id });
}

// ---- colour ------------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}/i;
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// #rrggbb toward #rrggbb by f.
function mix(a, b, f) {
  if (!HEX.test(a ?? "") || !HEX.test(b ?? "")) return a;
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v + (y[i] - v) * f));
}

// The same hue at f times the lightness: the flags' ink is their own colour, deeper.
function deeper(h, f) {
  if (!HEX.test(h ?? "")) return h;
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) hue = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = ((hue % 6) + 6) % 6;
  // A little less saturated as it deepens, as the mockup's ink is.
  const L = l * f, C = (1 - Math.abs(2 * L - 1)) * s * 0.85, X = C * (1 - Math.abs((hue % 2) - 1)), m = L - C / 2;
  const k = Math.floor(hue);
  const [p, q, w] = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][k];
  return hex([p + m, q + m, w + m].map((v) => v * 255));
}

// A status's colour, from the theme's status tokens: working, blocked (needs you), done, and
// idle (done, and you've seen it). Statuses here are the dock's own (see resolve below).
const color = (t, s) => (s === "blocked" ? t.blocked : s === "working" ? t.working : s === "idle" ? t.idle : s ? t.done : null);

// Program icons as one-colour glyphs (every shipped icon is an SVG); a picture otherwise, faded.
function glyph(p, size, c) {
  if (!p?.icon) return null;
  if (p.icon.endsWith(".svg")) return svg(p.icon).size(size).flex_none().text_color(c);
  return image(p.icon).w(size).h(size).flex_none().opacity(0.6);
}

// The agents bar's ruler, along the top of its row: a 1 px tick every `gap` px rising from
// its foot, every TICKS-th one tall, the tall ones on ANCHOR's beat (over the flags' arrows).
// All the ticks are one filled path, painted as one element. The path depends only on the
// bar's width and the spacing (which changes as flags crowd in), so the last one is kept and
// rebuilt only when either changes.
const RULER_H = STRIP - 5; // the ruler's height: its ticks' feet sit 5 px above the bar
let rulerCache = null;
function rulerPath(rw, gap) {
  if (rulerCache?.rw === rw && rulerCache.gap === gap) return rulerCache.path;
  const path = PathBuilder.fill();
  for (let i = -Math.floor(ANCHOR / gap); ANCHOR + i * gap < rw; i++) {
    const x = Math.round(ANCHOR + i * gap), top = RULER_H - (((i % TICKS) + TICKS) % TICKS === 0 ? 5.5 : 2.5);
    path.add_polygon([[x, top], [x + 1, top], [x + 1, RULER_H], [x, RULER_H]], true);
  }
  rulerCache = { rw, gap, path: path.build() };
  return rulerCache.path;
}
function ruler(t, rw, gap) {
  return div().absolute().top(0).left(0).right(0).h(RULER_H).child(window.paint_path(rulerPath(rw, gap), t.input));
}

// The dotted rule along the top of the spaces row, as one painted path rather than hundreds
// of dot elements: a 1 px line across the full width (0% to 100%), dashed 1.5 px on, 5 off,
// like the tab separators' dots. Built once; window.paint_path paints it in a colour.
const DOTTED_RULE = PathBuilder.stroke(1).dash_array([1.5, 5]).move_to(0, 0.5).line_to("100%", 0.5).build();
// The same dots standing up: the dotted divider between tabs. A percentage only works across
// (a path's "100%" down draws nothing), so it runs a fixed 200 px down and its box clips it to
// the tabs row's height.
const DOTTED_DIVIDER = PathBuilder.stroke(1).dash_array([1.5, 5]).move_to(0.5, 0).line_to(0.5, 200).build();

// ---- wordmark ----------------------------------------------------------------------------
// HERDR in a chunky pixel font on the right of the agents bar: cream letters (foreground),
// their bottom rows a shade darker, with a dark drop shadow down-right (chrome). Inside, an
// inset shadow as the old blooms had: the dark round each letter casts MARK_INSET px onto its
// top and left edges, so the cream reads as sitting under the bar. Each "#" is one pixel; the
// wordmark scales to MARK_SCALE of the bar's height under the ruler strip.
const FONT = {
  H: ["##..##", "##..##", "##..##", "######", "##..##", "##..##", "##..##"],
  E: ["######", "##....", "##....", "#####.", "##....", "##....", "######"],
  R: ["#####.", "##..##", "##..##", "#####.", "####..", "##.##.", "##..##"],
  D: ["#####.", "##..##", "##..##", "##..##", "##..##", "##..##", "#####."],
};
const WORD = "HERDR";
const MARK_SHADE = 0.3;  // how much darker the letters' bottom rows are, 0 to 1
const MARK_LOW = 2;      // how many bottom rows are shaded
const MARK_SCALE = 0.5;  // the wordmark's height: this much of the agents bar's height under the ruler
const MARK_DOWN = 2;     // how far below centre the wordmark sits, px
const MARK_DROP = 0.5;   // the drop shadow's offset, in letter pixels
const MARK_INSET = 2;    // the inset shadow's width, px
const MARK_INSET_DARK = 0.45; // how much darker than the letter the inset shadow is
const MARK_SPACE = 2;    // letter pixels between letters

// The letters' pixels on a grid with a one-cell margin all round (room for the shadow), worked
// out once as runs: each row's unbroken stretches of letter pixels ("rows", kind "lit", or
// "low" for the bottom rows) and of pixels with no letter above ("tops", where the inset shadow
// falls). A run starts where a pixel has no letter to its left, which is where the inset
// shadow falls on that side.
const mark = (() => {
  const lit = new Set(), rows = FONT[WORD[0]].length;
  let left = 1;
  for (const ch of WORD) {
    FONT[ch].forEach((row, r) => [...row].forEach((v, c) => { if (v === "#") lit.add(`${left + c},${r + 1}`); }));
    left += FONT[ch][0].length + MARK_SPACE;
  }
  const w = left - MARK_SPACE + 1, h = rows + 2;
  const runs = (y, on) => {
    const out = [];
    for (let x = 0; x < w; x++) {
      if (!on(x)) continue;
      const x0 = x;
      while (x + 1 < w && on(x + 1)) x++;
      out.push({ x0, x1: x + 1, y, kind: y > rows - MARK_LOW ? "low" : "lit" });
    }
    return out;
  };
  const rowRuns = [], tops = [];
  for (let y = 1; y <= rows; y++) {
    rowRuns.push(...runs(y, (x) => lit.has(`${x},${y}`)));
    tops.push(...runs(y, (x) => lit.has(`${x},${y}`) && !lit.has(`${x},${y - 1}`)));
  }
  return { rows: rowRuns, tops, w, h };
})();

// The wordmark's pixel size and width for an agents bar h px tall.
function markSize(h) {
  const px = Math.max(1, (((h || 80) - STRIP) * MARK_SCALE) / mark.h);
  return { px, markW: Math.round(mark.w * px) };
}

// The wordmark, right-aligned EDGE_RIGHT in from the bar's edge, centred under the ruler strip.
// Each colour is one filled path of rectangles (one per run), painted as one element: the drop
// shadow, the letters and their darker bottom rows, and the inset shadow on each (left and top
// edges in separate paths: where they overlap, at a letter's top-left corner, one path would
// leave a hole, as overlapping shapes in a path cancel out). The paths
// depend only on the pixel size, so the last set is kept and rebuilt when the bar's height
// changes. Edges are rounded to whole px, so neighbouring runs meet with no seams.
let markCache = null;
function markPaths(px) {
  if (markCache?.px === px) return markCache.paths;
  const X = (i) => Math.round(i * px), d = Math.max(1, Math.round(px * MARK_DROP));
  const paths = {};
  const add = (name, l, tp, w, h) => {
    paths[name] ??= PathBuilder.fill();
    paths[name].add_polygon([[l, tp], [l + w, tp], [l + w, tp + h], [l, tp + h]], true);
  };
  for (const { x0, x1, y, kind } of mark.rows) {
    const l = X(x0), tp = X(y), w = X(x1) - l, h = X(y + 1) - tp;
    add("shadow", l + d, tp + d, w, h);
    add(kind, l, tp, w, h);
    add(`${kind}Inset`, l, tp, MARK_INSET, h);              // the inset shadow, along the run's left edge
  }
  for (const { x0, x1, y, kind } of mark.tops) {
    const l = X(x0), tp = X(y);
    add(`${kind}Top`, l, tp, X(x1) - l, MARK_INSET);        // ...and along its top edge
  }
  for (const k of Object.keys(paths)) paths[k] = paths[k].build();
  markCache = { px, paths };
  return paths;
}
function wordmark(t, { px, markW }) {
  const low = mix(t.foreground, t.chrome, MARK_SHADE);
  const ink = {
    shadow: t.chrome, lit: t.foreground, low,
    litInset: mix(t.foreground, t.chrome, MARK_INSET_DARK), lowInset: mix(low, t.chrome, MARK_INSET_DARK),
  };
  ink.litTop = ink.litInset; ink.lowTop = ink.lowInset;
  const paths = markPaths(px);
  // Drawn in this order, so the letters cover the shadow and the insets sit on the letters.
  const layers = ["shadow", "lit", "low", "litInset", "lowInset", "litTop", "lowTop"].filter((k) => paths[k])
    .map((k) => div().absolute().top(0).left(0).right(0).bottom(0).child(window.paint_path(paths[k], ink[k])));
  return div().absolute().top(STRIP).bottom(0).right(EDGE_RIGHT).w(markW).flex().items_center()
    .child(div().relative().top(MARK_DOWN).w(markW).h(Math.round(mark.h * px)).flex_none().children(layers));
}

// ---- data --------------------------------------------------------------------------------

// "vps/t7" is on vps; "t7" is here ("").
const machineOf = (addr) => (addr?.includes("/") ? addr.split("/")[0] : "");
// A remote core's own ids (labels, parents) lack the "<machine>/" prefix the app's ids carry.
const qualify = (id, machine) => (!id || !machine || id.includes("/") ? id : `${machine}/${id}`);

// Whole minutes between two times, as the clock turns: every row redraws on the minute
// and agrees, and a label never runs behind.
function ago(at, now) {
  const m = Math.floor(now / 60000) - Math.floor(at / 60000);
  if (m < 1) return "1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Every agent: those with panes, then paneless helpers (sub-agents) from the core,
// which take their parent's space.
function everyAgent() {
  const list = agents().map((a) => ({ address: a.address, status: a.status, program: a.program, pane: a.pane, space: a.space, tab: a.tab }));
  const by = new Map(list.map((a) => [a.address, a]));
  // As the agents list: a helper reports to its parent, so it is never "done" (it has
  // simply finished: idle), and one that errored has finished too.
  let kids = terminals()
    .filter((k) => k.parent && k.state === "live" && !by.has(k.address))
    .map((k) => ({ k, status: k.status === "done" || k.status === "error" ? "idle" : k.status }))
    .filter((x) => KNOWN.has(x.status));
  // Parents first: a helper's helper finds its parent's space on a later pass.
  for (let pass = 0; pass < 4 && kids.length; pass++) {
    const later = [];
    for (const { k, status } of kids) {
      const m = machineOf(k.address);
      const parent = by.get(qualify(k.parent, m)) ?? by.get(k.parent);
      const space = parent?.space ?? qualify(k.labels?.["herdr.space"], m) ?? null;
      // No space after every pass: another app's terminal, not Herdr's.
      if (!space) { if (pass < 3) later.push({ k, status }); continue; }
      const tab = parent?.tab ?? qualify(k.labels?.["herdr.tab"], m) ?? null;
      const a = { address: k.address, status, program: k.program, pane: null, space, tab, helper: true };
      list.push(a);
      by.set(a.address, a);
    }
    kids = later;
  }
  return list;
}

// Gone agents' entries go, but only on machines the list has heard from: right after a
// start, or while a machine connects, its agents aren't listed yet. An address the core
// reuses later (after a restart) then starts over.
function goneFrom(list) {
  const listed = new Set(list.map((a) => a.address));
  const heard = new Set(list.map((a) => machineOf(a.address)));
  return (k) => !listed.has(k) && heard.has(machineOf(k));
}
function prune(map, list) {
  const gone = Object.keys(map).filter(goneFrom(list));
  if (!gone.length) return map;
  const next = { ...map };
  for (const k of gone) delete next[k];
  return next;
}

// When each agent last changed between working, blocked and finished (done and idle
// count as one, as in the agents list), shared and kept across restarts. Only the tabs
// copy writes (it is never hidden), so every row reads the same time; the others read.
let staged = null; // written but not yet back from shared()
function stamps(list, cx, write) {
  const old = staged ?? shared("docket.changed") ?? {};
  if (!write) return old;
  const now = Date.now();
  let next = prune(old, list);
  for (const a of list) {
    const s = a.status === "done" ? "idle" : a.status;
    const prev = next[a.address];
    if (prev?.s === s) continue;
    if (next === old) next = { ...old };
    // `worked`: it finished after working or waiting on you, rather than starting out idle.
    next[a.address] = { s, at: now, worked: s === "idle" && Boolean(prev) };
  }
  if (next === old) return old;
  staged = next;
  cx.timer.after(1, () => { setShared("docket.changed", next); if (staged === next) staged = null; });
  return next;
}

// Herdr turns "done" into "idle" the moment you look at an agent's tab, and a helper never
// reports done at all. The dock keeps its own: an agent that finished shows done until you
// open it (its flag, or switching to its pane), then idle. When each was last opened is
// shared, so every row agrees.
// Closed agents' entries are dropped (as prune does for stamps), so the record never grows.
function markSeen(address) {
  setShared("docket.seen", { ...prune(shared("docket.seen") ?? {}, everyAgent()), [address]: Date.now() });
}
function resolve(list, st) {
  const seen = shared("docket.seen") ?? {};
  return list.map((a) => {
    if (a.status !== "done" && a.status !== "idle") return a;
    const s = st[a.address];
    const done = a.status === "done" || (s?.s === "idle" && s.worked && (seen[a.address] ?? 0) < s.at);
    return done === (a.status === "done") ? a : { ...a, status: done ? "done" : "idle" };
  });
}

export default class Docket extends View {
  init(_props, cx) {
    this.part = props()?.part ?? "agents";
    this.w = 0;
    this.known = new Map();   // address -> "entering" | "in"
    this.admitted = new Set(); // addresses let into the stack; the rest wait their turn
    this.lastAdmit = 0;
    this.ghosts = new Map();  // address -> { a, x, token }, fading out where it stood
    this.pos = new Map();     // address -> where its flag sits now
    this.motion = new Map();  // address -> { kind: "enter" | "shift", delay, until }
    // Arrival order, first seen first, kept across restarts. Drawn newest on the left.
    try { this.order = JSON.parse(localStorage.getItem("order") ?? "[]"); } catch { this.order = []; }
    // Ctrl+Shift+B (keys.json: "docket.toggle-dock") collapses or expands the dock. Only the
    // tabs row listens: it is never hidden, and one listener toggles once.
    if (this.part === "tabs") cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // First, so a build replaced by a reload stops here instead of toggling too. Until it
        // wakes, a replaced build keeps waiting, and piled-up waiting builds get this row's
        // render interrupted: after editing this file, run `herdr-app do docket.wake` (a
        // command no copy acts on) to wake and stop them.
        cx.notify();
        if (c === "toggle-dock") toggleDock();
      }
    });
    // Times read in minutes: redraw as the minute turns, so every row agrees.
    if (this.part !== "spaces") {
      const tick = (cx) => { cx.notify(); cx.timer.after(60000 - (Date.now() % 60000), tick); };
      cx.timer.after(60000 - (Date.now() % 60000), tick);
    }
  }

  render(cx) {
    const t = theme();
    if (this.part === "spaces") return this.spacesBar(t, cx);
    if (this.part === "tabs") return this.tabsRow(t, cx);
    return this.agentsBar(t, cx);
  }

  button(t, id, name, tip, action, size = 18, on = false) {
    return div().id(id).size(32).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.foreground).cursor_pointer().tooltip(tip)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click(action)
      .child(svg(name.includes("/") ? name : ICON(name)).size(size));
  }

  tools(t) {
    const shut = collapsed();
    const panel = find(layout(), "docket-changes");
    const changes = Boolean(panel && !panel.hidden);
    const filesPanel = find(layout(), "docket-files");
    const files = Boolean(filesPanel && !filesPanel.hidden);
    return h_flex().flex_none().gap(2).items_center()
      // The Changes sidebar (docket-changes) on the right of the panes.
      .child(this.button(t, "changes", "mods/docket-changes/changes.svg", changes ? "Hide changes" : "Show changes",
        () => run("layout.toggle", { id: "docket-changes" }), 18, changes))
      // The Files sidebar (docket-files), beside Changes.
      .child(this.button(t, "files", "mods/workspace-chrome/files.svg", files ? "Hide files" : "Show files",
        () => run("layout.toggle", { id: "docket-files" }), 18, files))
      .child(this.button(t, "search", "search", "Search", () => run("app.palette")))
      .child(this.button(t, "machine-add", "server-plus", "Connect a machine", () => run("mod.open", { name: "machine-add" })))
      .child(this.button(t, "settings", "settings", "Settings", () => run("app.settings")))
      .child(this.button(t, "collapse", shut ? "panel-bottom-open" : "panel-bottom-close", shut ? "Expand dock" : "Collapse dock", toggleDock));
  }

  // ---- tabs ----------------------------------------------------------------------------

  // A dotted divider between tabs (see DOTTED_DIVIDER), from the pane border above to the
  // spaces row below.
  dots(t, id) {
    return div().id(id).h_full().w(1).flex_none().overflow_hidden().child(window.paint_path(DOTTED_DIVIDER, t.input));
  }

  tabsRow(t, cx) {
    const space = spaces().find((s) => s.active);
    const tabs = [...(space?.tabs ?? [])].sort((x, y) => x.index - y.index);
    // A new tab goes on the end of the list, however it was made (+, a key, an agent). Only
    // in a space this row has drawn before, so first sight of a space moves nothing.
    if (space) {
      const before = this.tabIds?.get(space.id);
      if (before) for (const c of tabs) {
        if (before.has(c.id) || c.index === tabs.length) continue;
        const id = c.id, index = tabs.length;
        cx.timer.after(1, () => run("tab.move", { id, index }));
      }
      const live = new Set(spaces().map((s) => s.id));
      this.tabIds = new Map([...(this.tabIds ?? [])].filter(([id]) => live.has(id)));
      this.tabIds.set(space.id, new Set(tabs.map((c) => c.id)));
    }
    const raw = everyAgent();
    const st = stamps(raw, cx, true);
    const list = resolve(raw, st);
    // Switching to an agent's pane counts as opening it (not the pane focused at start).
    const f = focused()?.pane ?? null;
    if (f !== this.lastFocus) {
      const first = this.lastFocus === undefined;
      this.lastFocus = f;
      const a = !first && f && list.find((a) => a.pane === f);
      if (a) cx.timer.after(1, () => markSeen(a.address));
    }
    const all = panes();
    const now = Date.now();
    // When the tabs would run into the menu on the right, they go compact: dots, icon and number.
    // Each tab's label (name and time) is measured while shown and remembered; until then it's
    // estimated from its length. Deciding from those, not from what's drawn, keeps it steady.
    this.labelW ??= new Map();
    const label = (c) => {
      const mine = all.filter((p) => p.tab === c.id);
      const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
      const prog = lead?.program;
      return { mine, lead, prog, name: c.named ? c.name : prog?.shell ? "Terminal" : prog?.name ?? c.name };
    };
    const need = tabs.reduce((sum, c, i) => {
      const { mine, prog, name } = label(c);
      const n = Math.max(1, mine.length);
      const est = 7 + Math.min(170, name.length * 8.3) + 12 + 24;
      return sum + (i === 0 ? 35.5 : 26) + 26 + 1 + n * 6 + (n - 1) * 4 + (prog?.icon ? 25 : 0) + (this.labelW.get(c.id) ?? est);
    }, 0) + 17 + 32;
    const compact = Boolean(this.tabsW) && need > this.tabsW;
    const tile = (c, i) => {
      const { mine, lead, prog, name } = label(c);
      const agent = list.find((a) => a.tab === c.id && a.pane === lead?.pane) ?? list.find((a) => a.tab === c.id && a.pane);
      const since = agent ? st[agent.address]?.at : c.working_since ?? c.changed_at;
      // One dot per pane: its agent's status as the dock sees it, idle for a pane with no agent.
      const dots = (mine.length ? mine : [null]).map((p) => {
        const a = p && list.find((a) => a.pane === p.pane);
        return (a && KNOWN.has(a.status)) ? a.status : "idle";
      });
      // The first tab's dot sits under the computer icon's centre (30 + 17 / 2) in the row below.
      const el = h_flex().id(`tab-${c.id}`).h(TAB_H).flex_none().pl(i === 0 ? 35.5 : 26).pr(26).items_center()
        // The active tab: its text and icon in the theme's burnt orange (ansi3).
        .text_color(c.active ? t.ansi3 : t.foreground).cursor_pointer()
        .on_mouse_down("left", (e) => {
          if (e.click_count === 2) run("tab.rename", { id: c.id });
          this.drag = { kind: "tab", id: c.id, over: c.id };
        })
        // Drag to reorder: the tab under the pointer marks where it lands; release there.
        .on_mouse_move((_e, cx) => {
          if (this.drag?.kind !== "tab" || this.drag.over === c.id) return;
          this.drag.over = c.id;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const d = this.drag; this.drag = null;
          if (d?.kind === "tab" && d.id !== c.id && tabs.some((x) => x.id === d.id)) run("tab.move", { id: d.id, index: c.index });
          cx.notify();
        })
        .when(this.drag?.kind === "tab" && this.drag.id === c.id && this.drag.over !== c.id, (el) => el.opacity(0.5))
        .when(this.drag?.kind === "tab" && this.drag.over === c.id && this.drag.id !== c.id, (el) => el.relative().child(
          div().absolute().top(6).bottom(6).w(2).bg(t.accent)
            .when((tabs.find((x) => x.id === this.drag.id)?.index ?? 0) < c.index, (l) => l.right(0))
            .when((tabs.find((x) => x.id === this.drag.id)?.index ?? 0) > c.index, (l) => l.left(0))))
        // A double-click's second release would select again over the rename prompt.
        .on_click((e) => { if ((e?.click_count ?? 1) <= 1) run("tab.select", { id: c.id }); })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } });
        })
        .child(h_flex().flex_none().gap(4).items_center().children(dots.map((st, j) =>
          div().id(`tdot-${c.id}-${j}`).size(6).flex_none().rounded_full().bg(color(t, st)))))
        .when(Boolean(prog?.icon), (el) => el.child(div().ml(9).flex_none().child(glyph(prog, 16, c.active ? t.ansi3 : t.foreground))))
        .when(!compact, (el) => el.child(h_flex().id(`tab-label-${c.id}`).flex_none().items_center()
          .on_size_change((size) => { this.labelW.set(c.id, size.width); })
          .child(div().ml(7).max_w(170).truncate().text_size(15).child(c.zoomed ? `${name} Z` : name))
          .child(div().ml(12).flex_none().text_size(12.5).child(since ? ago(since, now) : ""))))
        // Compact: the tab's number (as Ctrl+number picks it) in place of its name, which shows on hover.
        .when(compact, (el) => el.tooltip(c.zoomed ? `${name} Z` : name)
          .child(div().ml(7).flex_none().text_size(15).child(String(c.index))));
      return [el, this.dots(t, `sep-${c.id}`)];
    };
    return h_flex().size_full().min_w(0).items_center().bg(t.background)
      // A drag let go anywhere else in the row ends without a move (a tab's own release runs first).
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      // One tab per notch, or per 40 px of a trackpad swipe, not one per event.
      .on_scroll_wheel((e) => {
        if (e.touch_phase === "started") this.wheel = 0;
        this.wheel = (this.wheel ?? 0) + (e.delta_lines ? e.delta_lines.y * WHEEL : e.delta.y);
        if (Math.abs(this.wheel) < WHEEL) return;
        run(this.wheel > 0 ? "tab.prev" : "tab.next");
        this.wheel = 0;
      })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().overflow_x_scrollbar()
        .on_size_change((size, cx) => { if (size.width !== this.tabsW) { this.tabsW = size.width; cx.notify(); } })
        .children(tabs.flatMap(tile))
        .child(div().ml(17).flex_none().child(this.button(t, "tab-new", "plus", "New tab",
          () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), 14))))
      .child(div().pl(12).pr(14).child(this.tools(t)));
  }

  // ---- spaces --------------------------------------------------------------------------

  spacesBar(t, cx) {
    const raw = everyAgent();
    const list = resolve(raw, stamps(raw, cx, false));
    const all = spaces();
    // This computer first, then every machine by name, even one with no spaces yet.
    const remote = [...new Set([
      ...machines().map((m) => m.name).filter(Boolean),
      ...all.map((s) => s.machine).filter(Boolean),
    ])].sort();
    const groups = [null, ...remote].map((m) => ({ machine: m, spaces: all.filter((s) => (s.machine ?? null) === m) }));
    const item = (s) => {
      // One dot per agent; a space with none still shows one idle dot.
      const here = list.filter((a) => a.space === s.id).map((a) => a.status);
      const dots = (here.length ? here : ["idle"]).map((st, i) =>
        div().id(`dot-${s.id}-${i}`).size(6).flex_none().rounded_full().bg(color(t, st)));
      // Side padding SP_PAD fills the space between spaces, as a tab's fills the space to its divider.
      return h_flex().id(`sp-${s.id}`).flex_none().h_full().px(SP_PAD).gap(5).items_center().cursor_pointer()
        // The active space: its name in the theme's burnt orange (ansi3).
        .text_color(s.active ? t.ansi3 : t.foreground)
        .on_click(() => run("space.select", { id: s.id }))
        // Drag to reorder, within its machine: release over the space it should take the place of.
        .on_mouse_down("left", () => { this.drag = { kind: "space", id: s.id, over: s.id }; })
        .on_mouse_move((_e, cx) => {
          if (this.drag?.kind !== "space" || this.drag.over === s.id) return;
          const from = all.find((x) => x.id === this.drag.id);
          if ((from?.machine ?? null) !== (s.machine ?? null)) return;
          this.drag.over = s.id;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const d = this.drag; this.drag = null;
          const from = d?.kind === "space" ? all.find((x) => x.id === d.id) : null;
          if (from && d.id !== s.id && (from.machine ?? null) === (s.machine ?? null)) run("space.move", { id: d.id, index: all.indexOf(s) + 1 });
          cx.notify();
        })
        .when(this.drag?.kind === "space" && this.drag.id === s.id && this.drag.over !== s.id, (el) => el.opacity(0.5))
        .when(this.drag?.kind === "space" && this.drag.over === s.id && this.drag.id !== s.id, (el) => el.relative().child(
          div().absolute().top(8).bottom(8).w(2).bg(t.accent)
            .when(all.findIndex((x) => x.id === this.drag.id) < all.indexOf(s), (l) => l.right(SP_PAD - 9))
            .when(all.findIndex((x) => x.id === this.drag.id) > all.indexOf(s), (l) => l.left(SP_PAD - 9))))
        // The shipped space menu: Rename, worktree actions in a git repo, Close.
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } });
        })
        .children(dots)
        // Between the dots and the name, its number, as Alt+number picks it (its place in
        // Herdr's list of spaces): a dark number on a rounded square, cream, or burnt orange
        // (ansi3) for the active space, as its name.
        .child(div().size(SP_NUM).ml(3).flex_none().flex().items_center().justify_center().rounded(3)
          .bg(s.active ? t.ansi3 : t.foreground).text_color(t.accent_foreground).text_size(11).child(String(all.indexOf(s) + 1)))
        .child(div().ml(3).max_w(200).truncate().child(s.name));
    };
    const add = (m) => div().id(`sp-new-${m ?? "local"}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.foreground).cursor_pointer().tooltip(m ? `New space on ${m}` : "New space on this computer")
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.new", m ? { machine: m } : {}))
      .child(svg(ICON("plus")).size(12));
    return h_flex().relative().size_full().min_w(0).pt(SP_TOP).pl(30).pr(16).items_center().bg(t.background).text_size(15)
      // A dotted rule along the top, between the tabs and spaces rows (see DOTTED_RULE).
      .child(div().absolute().top(0).left(0).right(0).h(1).child(window.paint_path(DOTTED_RULE, t.input)))
      // A drag let go anywhere else in the row ends without a move (a space's own release runs first).
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .child(h_flex().id("sp-scroll").flex_1().min_w(0).h_full().items_center().gap(18).overflow_x_scrollbar()
        // A short rule after each group, as tall as their icons.
        .children(groups.flatMap((g, gi) => [
          // Gaps less the spaces' padding (24 between spaces, as before).
          h_flex().id(`grp-${gi}`).flex_none().h_full().gap(24 - 2 * SP_PAD).items_center()
            // The machine's icon, a remote machine's name close beside it, then 24 px to the
            // first space, as between spaces.
            .child(h_flex().flex_none().mr(SP_PAD).gap(8).items_center()
              .child(svg(ICON(g.machine ? "server" : "laptop")).size(17).text_color(t.input))
              .when(Boolean(g.machine), (el) => el.child(div().text_size(11.5).text_color(t.input).child(g.machine))))
            .children(g.spaces.map(item))
            .child(div().ml(SP_PAD - 8).child(add(g.machine))),
          div().id(`grp-rule-${gi}`).w(1).h(17).flex_none().bg(t.input),
        ])));
  }

  // ---- agents --------------------------------------------------------------------------

  open(a) {
    if (a.pane) run("pane.focus", { pane: a.pane });
    else run("terminal.peek", { terminal: a.address });
    markSeen(a.address);
  }

  // Appends agents not seen before and drops closed ones (only on machines the list has
  // heard from); the rest keep their places.
  syncOrder(list) {
    const gone = goneFrom(list);
    const kept = this.order.filter((k) => !gone(k));
    const known = new Set(kept);
    const next = [...kept, ...list.map((a) => a.address).filter((k) => !known.has(k))];
    if (next.length !== this.order.length || next.some((k, i) => k !== this.order[i])) {
      this.order = next;
      try { localStorage.setItem("order", JSON.stringify(next)); } catch {}
    }
  }

  // A flag: its arrow on the ruler strip, its body hanging into the bar. A closed one
  // (`live` false) takes no clicks while it fades out. `current`: the agent in the focused
  // pane, whose outline turns cream (foreground), or burnt orange (ansi3) on an idle flag,
  // which is cream itself.
  flag(t, a, x, opacity, label, tip, live = true, m = null, current = false) {
    const c = color(t, a.status);
    // Pixel block style: a dark outline (its top tucked under the row above), a
    // dark drop shadow down-right, stepped bottom corners, and a darker band along the
    // bottom. Each block is BP px.
    const block = (l, tp, w, h, bg) => div().absolute().left(l).top(tp).w(w).h(h).bg(bg);
    // A slab with its bottom corners stepped in by one block.
    const slab = (l, tp, w, h, bg) => [block(l, tp, w, h - BP, bg), block(l + BP, tp + h - BP, w - 2 * BP, BP, bg)];
    const inner = FH - BP; // the coloured face, inside the outline
    // A pixel arrow on the ruler strip: rows widening toward the flag.
    const arrow = div().relative().w(FW).h(CARET).flex_none()
      .children([[4, 0, 2], [8, 2, 2], [12, 4, 3]].map(([w, tp, h]) =>
        block((FW - w) / 2, tp, w, h, mix(t.chrome, c, 0.45))));
    return v_flex().id(`ag-${a.address}`).absolute().top(STRIP - CARET).left(x).w(FW).h(CARET + FH).items_center()
      .opacity(opacity)
      .transition("left", m ? { ...(m.kind === "enter" ? ENTER : SHIFT), delay: m.delay } : SHIFT)
      .transition("opacity", FADE_OUT)
      .when(live, (el) => el.cursor_pointer().tooltip(tip).on_click(() => this.open(a)))
      .child(arrow)
      .child(v_flex().relative().w_full().h(FH).flex_none().items_center()
        // Room under the icon, clear of the bottom band.
        .justify_end().pb(11).gap(5)
        .children(slab(BP, BP, FW, FH, t.chrome))                       // drop shadow
        .children(slab(0, 0, FW, FH, !current ? t.chrome : a.status === "idle" ? t.ansi3 : t.foreground)) // outline
        .children(slab(BP, 0, FW - 2 * BP, inner, c))                    // face
        .children(slab(BP, inner - 2 * BP, FW - 2 * BP, 2 * BP, mix(c, t.chrome, FLAG_SHADE))) // bottom band
        // Needs you, or working: a dark wash over the colour, under the time and icon, pulses
        // it slightly darker.
        .when(FLASH.has(a.status), (el) => el.children(slab(BP, 0, FW - 2 * BP, inner, t.chrome)
          .map((b) => b.loop("opacity", FLASH_LOOP))))
        // An idle flag's label in the active tab's text colour; the others in their own colour, deepened.
        .child(div().h(17).text_size(13).text_color(a.status === "idle" ? t.accent_foreground : deeper(c, 0.28)).child(label))
        .child(glyph(a.program, 17, deeper(c, 0.86)) ?? div().size(17))
        // ...and the icon pulses with it: a dark copy over it, on the same beat.
        .when(FLASH.has(a.status) && Boolean(a.program?.icon?.endsWith(".svg")), (el) => el.child(
          div().absolute().bottom(11).left((FW - 17) / 2).size(17)
            .child(glyph(a.program, 17, t.chrome)).loop("opacity", FLASH_LOOP))));
  }

  agentsBar(t, cx) {
    const W = this.w;
    // Under the ruler, a shade darker than the panes (the theme's `raised`). The ruler strip
    // itself stays pane blue (`background`), so the dark starts at the ruler's foot.
    const root = div().id("root").relative().size_full().overflow_hidden().bg(t.background)
      .on_size_change((size, cx) => {
        if (size.width !== this.w || size.height !== this.h) { this.w = size.width; this.h = size.height; cx.notify(); }
      })
      .child(div().absolute().top(STRIP).left(0).right(0).bottom(0).bg(t.raised));
    if (!W) return root;

    const raw = everyAgent();
    const st = stamps(raw, cx, false);
    const list = resolve(raw, st);
    const now = Date.now();
    const names = new Map(spaces().map((s) => [s.id, s.name]));
    const here = focused()?.pane ?? null; // the focused pane: its agent's flag is outlined
    this.syncOrder(list);
    const by = new Map(list.map((a) => [a.address, a]));
    const arrived = this.order.map((k) => by.get(k)).filter(Boolean);
    // Several newcomers at once come on one at a time, ADMIT apart, each as if it came
    // alone; those already here when the dock first draws are simply there.
    if (!this.started && arrived.length) {
      this.started = true;
      for (const a of arrived) { this.admitted.add(a.address); this.known.set(a.address, "in"); }
    }
    let waiting = arrived.filter((a) => !this.admitted.has(a.address));
    if (waiting.length && now - this.lastAdmit >= ADMIT) {
      this.admitted.add(waiting[0].address);
      this.lastAdmit = now;
      waiting = waiting.slice(1);
    }
    if (waiting.length && !this.admitTimer) {
      this.admitTimer = true;
      cx.timer.after(Math.max(1, ADMIT - (now - this.lastAdmit)), (cx) => { this.admitTimer = false; cx.notify(); });
    }
    const stack = arrived.filter((a) => this.admitted.has(a.address)).reverse(); // newest on the left
    setAgentOrder(stack.map((a) => a.address));

    // When they don't fit, flags close up and overlap (older ones, further
    // right, underneath) rather than run into them.
    const step = FW + GAP;
    const size = markSize(this.h);
    const room = W - LEFT - size.markW - EDGE_RIGHT - 16 - FW; // flags stop short of the wordmark
    const s = stack.length > 1 ? Math.max(10, Math.min(step, room / (stack.length - 1))) : step;
    const place = new Map(stack.map((a, i) => [a.address, LEFT + i * s]));

    // Closed agents fade out where they stood while the rest close up. Each ghost has its
    // own token, so an older timer never removes a newer ghost.
    for (const [addr] of this.known) {
      if (place.has(addr)) continue;
      this.known.delete(addr);
      if (!by.has(addr)) this.admitted.delete(addr);
      const a = this.last?.get(addr);
      if (!a) continue;
      const token = {};
      this.ghosts.set(addr, { a, x: this.pos.get(addr) ?? LEFT, token });
      cx.timer.after(FADE_OUT.duration + 80, (cx) => {
        if (this.ghosts.get(addr)?.token !== token) return;
        this.ghosts.delete(addr);
        cx.notify();
      });
    }
    // A newcomer draws once past the left edge, then slides in to the first place. Settled
    // flags whose place changes move along, each RIPPLE after the one to its left. A motion's
    // policy stays put until it has played, so a redraw mid-flight never restarts it.
    for (const [k, m] of this.motion) if (m.until <= now) this.motion.delete(k);
    for (const a of stack) {
      if (this.known.has(a.address)) continue;
      this.known.set(a.address, "entering");
      this.motion.set(a.address, { kind: "enter", delay: 0, until: now + 40 + ENTER.duration });
      cx.timer.after(40, (cx) => { if (this.known.get(a.address) === "entering") this.known.set(a.address, "in"); cx.notify(); });
    }
    let moving = 0;
    const flags = [];
    for (const a of stack) {
      this.ghosts.delete(a.address);
      let x = place.get(a.address);
      const state = this.known.get(a.address);
      if (state === "in" && this.motion.get(a.address)?.kind !== "enter" && this.pos.has(a.address) && this.pos.get(a.address) !== x) {
        const delay = moving++ * RIPPLE;
        this.motion.set(a.address, { kind: "shift", delay, until: now + delay + SHIFT.duration });
      }
      if (state !== "in") x = -FW - 20;
      this.pos.set(a.address, x);
      const at = st[a.address]?.at ?? 0;
      const what = a.status === "blocked" ? "needs you" : a.status === "working" ? "working" : a.status === "done" ? "done" : "idle";
      const tip = `${a.program?.name ?? "Agent"}${a.helper ? " (helper)" : ""} · ${names.get(a.space) ?? ""} · ${what}`;
      flags.push(this.flag(t, a, x, 1, at ? ago(at, now) : "", tip, true, this.motion.get(a.address), Boolean(here && a.pane === here)));
    }
    // Older flags sit under newer ones when they overlap: draw right to left.
    flags.reverse();
    for (const [addr, g] of this.ghosts) {
      this.pos.delete(addr); this.motion.delete(addr);
      flags.unshift(this.flag(t, g.a, g.x, 0, "", "", false));
    }
    this.last = by;

    // The ruler on the strip, anchored on the arrows: slot i's arrow (its flag's centre,
    // LEFT + i * s + FW / 2) sits on a tall mark, so when flags close up, the ruler does too.
    // The wordmark under the flags, so a crowded stack of flags never hides behind it.
    return root.child(ruler(t, W, s / TICKS)).child(wordmark(t, size)).children(flags);
  }
}
