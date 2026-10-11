// Connect War (real-time mode). No turns: every action has a per-player cooldown.
// First to 5 fours wins. After 5 minutes the higher score wins; a tie goes to sudden death
// (cooldowns at 1/4) until someone scores. Uses the board helpers from game.js.
(function (root) {
  const C = root.CW || require("./game.js");
  const { ROWS, COLS, L, AB, opp } = C;
  const GCD = 150; // global cooldown after any action
  const DROP_CD = 2500, MATCH_MS = 5 * 60 * 1000, TARGET = 5, FREEZE_MS = 5000;
  const CD = { block: 5000, freeze: 5000, anchor: 5000, lift: 5000, pop: 7500, swap: 10000, double: 10000, flip: 10000, gravity: 15000, grenade: 7500 };
  const DESC = {
    ...Object.fromEntries(Object.entries(AB).map(([k, v]) => [k, v.desc])),
    freeze: "Lock a column for your opponent for 5 seconds.",
    double: "Instantly reset your drop cooldown."
  };

  function newGame(now) {
    return {
      mode: "rt", grid: C.blank(0), anc: C.blank(false), cur: 0,
      score: { 1: 0, 2: 0 }, ready: { 1: {}, 2: {} }, frozen: [], pending: null,
      endsAt: now + MATCH_MS, sudden: false, over: false, result: null, win: [],
      last: null, note: "", ev: null, seq: 0
    };
  }
  const mult = g => (g.sudden ? 0.25 : 1);
  const gcdFree = (g, seat, now) => (g.ready[seat].gcd || 0) <= now;
  const isReady = (g, seat, key, now) => (g.ready[seat][key] || 0) <= now && gcdFree(g, seat, now);
  const frozenFor = (g, seat, c, now) => g.frozen.some(f => f.player === seat && f.col === c && f.until > now);

  function canDrop(g, seat, c, now) {
    return !g.over && c >= 0 && c < COLS && isReady(g, seat, "drop", now) && C.topEmpty(g, c) >= 0 && !frozenFor(g, seat, c, now);
  }

  const CONTEST_MS = 500;
  function removeCells(g, cells) {
    for (const k of cells) { const [r, c] = k.split(",").map(Number); g.grid[r][c] = 0; g.anc[r][c] = false; }
    for (let c = 0; c < COLS; c++) C.writeStack(g, c, C.stack(g, c));
    g.last = null;
  }
  // Look for new fours. A first four starts a 0.25s "Contested!" window; a four by the other
  // player inside that window (or at the same instant) cancels both. Bounded to avoid loops.
  function settle(g, mover, ev, now, depth = 0) {
    if (depth > 8) return;
    const pend = g.pending, pset = new Set(pend ? pend.cells : []);
    const found = [1, 2].map(p => ({ p, cells: C.lines(g, p).filter(k => !(pend && pend.p === p && pset.has(k))) }))
      .filter(f => f.cells.length);
    if (!found.length) return postCheck(g, ev);
    const rivals = pend ? found.filter(f => f.p !== pend.p) : [];
    if ((pend && rivals.length) || (!pend && found.length === 2)) {
      const groups = pend ? [{ p: pend.p, cells: pend.cells }, ...rivals] : found;
      if (!ev.prev) ev.prev = C.clone(g);
      ev.clears = groups; ev.contested = true;
      removeCells(g, groups.flatMap(f => f.cells));
      g.pending = null;
      g.note = "Contested! Both fours cancel out.";
      return settle(g, mover, ev, now, depth + 1);
    }
    if (pend) { // same player made another four inside the window: it counts too
      pend.cells = [...pset, ...found[0].cells]; pend.count++;
      return postCheck(g, ev);
    }
    g.pending = { p: found[0].p, cells: found[0].cells, until: now + CONTEST_MS, count: 1 };
    ev.pending = true;
    g.note += ` Player ${found[0].p} connected four. Contested!`;
    postCheck(g, ev);
  }
  function postCheck(g, ev) {
    const a = g.score[1], b = g.score[2];
    if (g.sudden && a !== b) finish(g, a > b ? 1 : 2);
    else if ((a >= TARGET || b >= TARGET) && a !== b) finish(g, a > b ? 1 : 2);
    if (!g.over && !g.pending && C.isFull(g)) {
      g.grid = C.blank(0); g.anc = C.blank(false); g.last = null; ev.wipe = true;
      g.note += " Board full, so it was wiped.";
    }
  }
  function finish(g, w) {
    g.over = true; g.result = w; g.pending = null;
    g.note = `Player ${w} wins ${g.score[w]}–${g.score[opp(w)]}.`;
  }

  function drop(g, seat, c, now) {
    if (g.over) return "The match is over.";
    if (!gcdFree(g, seat, now)) return "Too fast.";
    if (!isReady(g, seat, "drop", now)) return "Drop is cooling down.";
    if (c < 0 || c >= COLS || C.topEmpty(g, c) < 0) return `Column ${L[c] || "?"} is full.`;
    if (frozenFor(g, seat, c, now)) return `Column ${L[c]} is frozen.`;
    const r = C.topEmpty(g, c);
    g.grid[r][c] = seat; g.last = { r, c };
    g.ready[seat].drop = now + DROP_CD * mult(g);
    g.ready[seat].gcd = now + GCD;
    const ev = { type: "drop", r, c };
    g.note = `Player ${seat} dropped in ${L[c]}.`;
    settle(g, seat, ev, now);
    g.ev = ev; g.seq++;
    return null;
  }

  function ability(g, seat, a, loadout, now) {
    const id = a && a.id;
    if (!AB[id]) return "Unknown ability.";
    if (g.over) return "The match is over.";
    if (!loadout || !loadout.includes(id)) return `${AB[id].name} isn't in your loadout.`;
    if (!gcdFree(g, seat, now)) return "Too fast.";
    if (!isReady(g, seat, id, now)) return `${AB[id].name} is cooling down.`;
    g.cur = seat;
    const t = AB[id].t, c = a.c;
    if (t === "col" && !C.validCol(g, id, c)) return `Not a valid column for ${AB[id].name}.`;
    if (id === "anchor" && !C.validCell(g, id, a.r, a.c)) return "Pick one of your own unanchored discs.";
    if (id === "swap" && !C.partner(g, a.r, a.c, a.r2, a.c2)) return "Pick two adjacent, unanchored discs of different colors.";

    let ev = { type: id }, note = "";
    const p = seat;
    if (id === "block") { const r = C.topEmpty(g, c); g.grid[r][c] = 3; g.last = { r, c }; ev = { type: "block", r, c }; note = `Player ${p} placed a stone in ${L[c]}.`; }
    if (id === "freeze") { g.frozen = g.frozen.filter(f => f.until > now); g.frozen.push({ col: c, player: opp(p), until: now + FREEZE_MS }); ev = { type: "freeze", c }; note = `Player ${p} froze column ${L[c]}.`; }
    if (id === "lift") { const t2 = C.topDisc(g, c); ev = { type: "lift", r: t2, c, v: g.grid[t2][c] }; g.grid[t2][c] = 0; g.anc[t2][c] = false; note = `Player ${p} lifted a disc from ${L[c]}.`; }
    if (id === "pop") { ev = { type: "pop", c, prev: C.clone(g) }; const f = C.floorRow(g); g.grid[f][c] = 0; g.anc[f][c] = false; C.writeStack(g, c, C.stack(g, c)); g.last = null; note = `Player ${p} popped column ${L[c]}.`; }
    if (id === "flip") { ev = { type: "flip", c, prev: C.clone(g) }; C.writeStack(g, c, C.stack(g, c).reverse()); g.last = null; note = `Player ${p} flipped column ${L[c]}.`; }
    if (id === "anchor") { g.anc[a.r][a.c] = true; ev = { type: "anchor", r: a.r, c: a.c }; note = `Player ${p} anchored a disc.`; }
    if (id === "swap") {
      [g.grid[a.r][a.c], g.grid[a.r2][a.c2]] = [g.grid[a.r2][a.c2], g.grid[a.r][a.c]];
      ev = { type: "swap", r: a.r, c: a.c, r2: a.r2, c2: a.c2 }; g.last = null; note = `Player ${p} swapped two discs.`;
    }
    if (id === "grenade") { const r = C.topEmpty(g, c); C.placeGrenade(g, r, c, now); g.last = { r, c }; ev = { type: "block", r, c }; note = `Player ${p} dropped a grenade in ${L[c]}.`; }
    if (id === "gravity") { ev = { type: "gravity", prev: C.clone(g) }; C.flipGravity(g); note = `Player ${p} flipped gravity. Discs now fall ${C.up(g) ? "up" : "down"}.`; }
    if (id === "double") { g.ready[p].drop = 0; ev = { type: "double" }; note = `Player ${p} reset their drop cooldown.`; }
    g.ready[p][id] = now + CD[id] * mult(g);
    g.ready[p].gcd = now + GCD;
    g.note = note;
    // Flip/Pop keep their own pre-animation; a score from them still counts.
    const pre = ev.prev;
    settle(g, p, ev, now);
    if (pre) { ev.prev = pre; delete ev.clears; }
    g.ev = ev; g.seq++;
    return null;
  }

  // Host calls this a few times a second. Returns true when something changed.
  function tick(g, now) {
    if (g.over) return false;
    g.frozen = g.frozen.filter(f => f.until > now);
    const due = (g.bombs || []).find(b => b.until <= now);
    if (due) {
      const ev = C.detonate(g, due.id);
      if (ev) {
        g.note = "A grenade exploded.";
        const pre = { prev: ev.prev, clears: ev.clears };
        settle(g, 1, ev, now);
        if (!ev.contested) Object.assign(ev, pre);
        g.ev = ev; g.seq++;
        return true;
      }
    }
    if (g.pending && now >= g.pending.until) {
      const pd = g.pending; g.pending = null;
      const ev = { type: "score", prev: C.clone(g), clears: [{ p: pd.p, cells: pd.cells.filter(k => { const [r, c] = k.split(",").map(Number); return g.grid[r][c] === pd.p; }) }] };
      removeCells(g, ev.clears[0].cells);
      g.score[pd.p] += pd.count;
      g.note = `Player ${pd.p} scored!`;
      settle(g, pd.p, ev, now);
      g.ev = ev; g.seq++;
      return true;
    }
    if (!g.sudden && now >= g.endsAt) {
      const a = g.score[1], b = g.score[2];
      if (a !== b) finish(g, a > b ? 1 : 2);
      else {
        g.sudden = true;
        for (const s of [1, 2]) for (const k in g.ready[s]) g.ready[s][k] = Math.min(g.ready[s][k], now + (g.ready[s][k] - now) * 0.25);
        g.note = "Time! Sudden death: cooldowns cut to 1/4. Next score wins.";
      }
      g.ev = { type: g.over ? "end" : "sudden" }; g.seq++;
      return true;
    }
    return false;
  }

  const api = { GCD, gcdFree, CONTEST_MS, DROP_CD, MATCH_MS, TARGET, FREEZE_MS, CD, DESC, newGame, canDrop, drop, ability, tick, isReady, frozenFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RT = api;
})(typeof window !== "undefined" ? window : globalThis);
