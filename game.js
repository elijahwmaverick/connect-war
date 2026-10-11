// Connect War rules engine. Shared by the server (authoritative) and the browser (for highlighting targets).
(function (root) {
  const ROWS = 7, COLS = 8, MAXE = 7, TURN_S = 20, L = "ABCDEFGH";
  const AB = {
    block:  { name: "Block",       cost: 2, t: "col",  desc: "Drop a neutral stone that counts for no one." },
    freeze: { name: "Freeze",      cost: 2, t: "col",  desc: "Lock a column for the opponent's next turn." },
    anchor: { name: "Anchor",      cost: 2, t: "own",  desc: "Make one of your discs immune to Pop and Swap." },
    lift:   { name: "Lift",        cost: 2, t: "col",  desc: "Remove your own top disc from a column." },
    pop:    { name: "Pop",         cost: 3, t: "col",  desc: "Remove the opponent's bottom disc. Everything above falls." },
    swap:   { name: "Swap",        cost: 4, t: "pair", desc: "Swap two adjacent discs, one yours and one theirs." },
    double: { name: "Double Drop", cost: 4, t: "none", desc: "Drop a second disc in another column. It can't complete a 4." },
    flip:   { name: "Flip",        cost: 5, t: "col",  desc: "Invert one column top to bottom." },
    grenade:{ name: "Grenade",     cost: 3, t: "col",  desc: "Drop a grenade. After 2 seconds it explodes, destroying the discs directly above, below, left and right of it." },
    reinforce:{ name: "Reinforce", cost: 3, t: "col",  desc: "Slide your disc into the floor end of a column, pushing the stack away from the floor." },
    gravity:{ name: "Gravity Flip", cost: 6, t: "none", desc: "Reverse gravity. All discs fly to the other side, and new discs come from there until it's flipped again." }
  };
  const opp = p => 3 - p;
  const blank = v => Array.from({ length: ROWS }, () => Array(COLS).fill(v));
  const clone = g => ({ grid: g.grid.map(r => r.slice()), anc: g.anc.map(r => r.slice()) });

  function newGame(starter) {
    const g = {
      grid: blank(0), anc: blank(false), cur: starter,
      energy: { [starter]: 0, [opp(starter)]: 1 },
      frozen: null, abilityUsed: false, dropsLeft: 1, dropsMade: 0, dd: false, firstCol: null,
      over: false, result: null, win: [], last: null, gained: 0, note: "", ev: null, seq: 0, turnId: 0
    };
    startTurn(g);
    return g;
  }

  // g.gdir: 1 = gravity down (default), -1 = gravity up (discs rest against the top, new discs rise from below).
  // Value 5 is a fixed stone (Full Auto scored four): it never moves, and discs stack against it.
  const FIXED = 5;
  const up = g => g.gdir === -1;
  const floorRow = g => (up(g) ? 0 : ROWS - 1);
  // Where the next disc lands in column c: it travels in from the entry side until something blocks it (-1 when blocked at once).
  const topEmpty = (g, c) => {
    if (up(g)) { if (g.grid[ROWS - 1][c]) return -1; let r = ROWS - 1; while (r - 1 >= 0 && !g.grid[r - 1][c]) r--; return r; }
    if (g.grid[0][c]) return -1; let r = 0; while (r + 1 < ROWS && !g.grid[r + 1][c]) r++; return r;
  };
  // The first occupied cell met from the entry side.
  const topDisc = (g, c) => {
    if (up(g)) { for (let r = ROWS - 1; r >= 0; r--) if (g.grid[r][c]) return r; return -1; }
    for (let r = 0; r < ROWS; r++) if (g.grid[r][c]) return r; return -1;
  };
  const isFull = g => { for (let c = 0; c < COLS; c++) if (topEmpty(g, c) >= 0) return false; return true; };
  const count = (g, c) => g.grid.reduce((n, row) => n + (row[c] ? 1 : 0), 0);
  // Stretches of a column between fixed stones, as [lo, hi] row ranges.
  function segs(g, c) {
    const out = []; let lo = null;
    for (let r = 0; r <= ROWS; r++) {
      const wall = r === ROWS || g.grid[r][c] === FIXED;
      if (!wall && lo === null) lo = r;
      if (wall && lo !== null) { out.push([lo, r - 1]); lo = null; }
    }
    return out;
  }
  const segRows = (g, [lo, hi]) => { const rs = []; if (up(g)) for (let r = lo; r <= hi; r++) rs.push(r); else for (let r = hi; r >= lo; r--) rs.push(r); return rs; };
  // Movable discs in a stretch, floor side first.
  const segStack = (g, c, sg) => segRows(g, sg).filter(r => g.grid[r][c]).map(r => [g.grid[r][c], g.anc[r][c]]);
  function writeSeg(g, c, sg, list) {
    const rs = segRows(g, sg);
    rs.forEach(r => { g.grid[r][c] = 0; g.anc[r][c] = false; });
    list.forEach(([v, a], i) => { g.grid[rs[i]][c] = v; g.anc[rs[i]][c] = a; });
  }
  // Let every movable disc in a column settle toward the floor (fixed stones stay put).
  function compactCol(g, c) { for (const sg of segs(g, c)) writeSeg(g, c, sg, segStack(g, c, sg)); }
  function flipCol(g, c) { for (const sg of segs(g, c)) writeSeg(g, c, sg, segStack(g, c, sg).reverse()); }
  // The stretch touching the floor, or null when a fixed stone sits on the floor.
  const floorSeg = (g, c) => segs(g, c).find(([lo, hi]) => floorRow(g) >= lo && floorRow(g) <= hi) || null;
  // Legacy whole-column helpers (no fixed stones in play).
  function stack(g, c) { return segs(g, c).length === 1 ? segStack(g, c, segs(g, c)[0]) : []; }
  function writeStack(g, c, s) { const sg = [0, ROWS - 1]; writeSeg(g, c, sg, s); }
  function lines(g, p) {
    const out = new Set(), D = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) for (const [dr, dc] of D) {
      const cells = [];
      for (let k = 0; k < 4; k++) {
        const rr = r + dr * k, cc = c + dc * k;
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || g.grid[rr][cc] !== p) break;
        cells.push(rr + "," + cc);
      }
      if (cells.length === 4) cells.forEach(x => out.add(x));
    }
    return [...out];
  }

  function startTurn(g) {
    g.turnId++;
    g.gained = g.energy[g.cur] < MAXE ? 1 : 0;
    g.energy[g.cur] += g.gained;
    Object.assign(g, { abilityUsed: false, dropsLeft: 1, dropsMade: 0, dd: false, firstCol: null });
    if (!anyDrop(g)) {
      const p = g.cur;
      endTurn(g);
      g.note += ` Player ${p} had no open column, so the turn was skipped.`;
    }
  }
  function endTurn(g) {
    if (g.frozen && g.frozen.player === g.cur) g.frozen = null;
    g.cur = opp(g.cur);
    startTurn(g);
  }
  function finish(g, w, cells) {
    g.over = true; g.result = w; g.win = cells;
    g.note = w ? `Player ${w} connects four.` : "Board full. Draw.";
    return true;
  }
  function resolve(g) {
    const a = lines(g, g.cur), b = lines(g, opp(g.cur));
    if (a.length) return finish(g, g.cur, a);
    if (b.length) return finish(g, opp(g.cur), b);
    if (isFull(g)) return finish(g, 0, []);
    return false;
  }

  function canDrop(g, c) {
    if (c < 0 || c >= COLS || topEmpty(g, c) < 0) return false;
    const f = g.frozen;
    if (f && f.player === g.cur && f.col === c) return false;
    if (g.dd && g.dropsMade === 1) {
      if (c === g.firstCol) return false;
      const r = topEmpty(g, c);
      g.grid[r][c] = g.cur; const w = lines(g, g.cur).length > 0; g.grid[r][c] = 0;
      if (w) return false;
    }
    return true;
  }
  function anyDrop(g) { for (let c = 0; c < COLS; c++) if (canDrop(g, c)) return true; return false; }

  // Returns an error string, or null on success.
  function drop(g, c) {
    if (g.over) return "The match is over.";
    if (!canDrop(g, c)) {
      const f = g.frozen;
      if (f && f.player === g.cur && f.col === c) return `Column ${L[c]} is frozen this turn.`;
      if (topEmpty(g, c) < 0) return `Column ${L[c]} is full.`;
      if (c === g.firstCol) return "The second disc must go in a different column.";
      return "The second Double Drop disc can't complete a 4.";
    }
    const p = g.cur, r = topEmpty(g, c);
    g.grid[r][c] = p; g.last = { r, c };
    g.ev = { type: "drop", r, c }; g.seq++;
    g.note = `Player ${p} dropped in ${L[c]}.`;
    if (g.dropsMade === 0) g.firstCol = c;
    g.dropsMade++;
    if (resolve(g)) return null;
    if (g.dropsMade >= g.dropsLeft || !anyDrop(g)) endTurn(g);
    else g.note = `Player ${p} used Double Drop and places a second disc.`;
    return null;
  }

  function validCol(g, id, c) {
    if (c < 0 || c >= COLS) return false;
    const p = g.cur;
    switch (id) {
      case "block": case "freeze": case "grenade": return topEmpty(g, c) >= 0;
      case "lift": { const t = topDisc(g, c); return t >= 0 && g.grid[t][c] === p; }
      case "pop": { const f = floorRow(g); return g.grid[f][c] === opp(p) && !g.anc[f][c]; }
      case "flip": return count(g, c) >= 2;
      case "reinforce": { const sg = floorSeg(g, c); return !!sg && segStack(g, c, sg).length < sg[1] - sg[0] + 1; }
    }
    return false;
  }
  const inB = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  function partner(g, r1, c1, r2, c2) {
    if (!inB(r1, c1) || !inB(r2, c2)) return false;
    if (Math.abs(r1 - r2) + Math.abs(c1 - c2) !== 1) return false;
    const a = g.grid[r1][c1], b = g.grid[r2][c2];
    return (a === 1 || a === 2) && !g.anc[r1][c1] && (b === 1 || b === 2) && a !== b && !g.anc[r2][c2];
  }
  function swapFirst(g, r, c) {
    if (!inB(r, c)) return false;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => partner(g, r, c, r + dr, c + dc));
  }
  function validCell(g, id, r, c, sel) {
    if (!inB(r, c)) return false;
    if (id === "anchor") return g.grid[r][c] === g.cur && !g.anc[r][c];
    if (id === "swap") return sel ? partner(g, sel[0], sel[1], r, c) : swapFirst(g, r, c);
    return false;
  }
  function hasTarget(g, id) {
    const t = AB[id].t;
    if (t === "col") { for (let c = 0; c < COLS; c++) if (validCol(g, id, c)) return true; return false; }
    if (t === "own" || t === "pair") {
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (validCell(g, id, r, c, null)) return true;
      return false;
    }
    return true;
  }
  function abilityReady(g, id, loadout) {
    return !!AB[id] && loadout.includes(id) && !g.over && g.dropsMade === 0 && !g.abilityUsed && g.energy[g.cur] >= AB[id].cost;
  }

  // a = { id, c } | { id, r, c } | { id, r, c, r2, c2 } | { id }. Returns an error string, or null.
  function ability(g, a, loadout) {
    const id = a && a.id;
    if (!AB[id]) return "Unknown ability.";
    if (!abilityReady(g, id, loadout)) return `${AB[id].name} isn't available right now.`;
    const p = g.cur, nm = AB[id].name, t = AB[id].t;
    if (t === "col" && !validCol(g, id, a.c)) return `Not a valid column for ${nm}.`;
    if (id === "anchor" && !validCell(g, id, a.r, a.c)) return "Pick one of your own unanchored discs.";
    if (id === "swap" && !partner(g, a.r, a.c, a.r2, a.c2)) return "Pick two adjacent, unanchored discs of different colors.";

    g.energy[p] -= AB[id].cost; g.abilityUsed = true;
    const c = a.c;
    let ev = { type: id }, note = "";
    if (id === "block") { const r = topEmpty(g, c); g.grid[r][c] = 3; g.last = { r, c }; ev = { type: "block", r, c }; note = `Player ${p} placed a stone in ${L[c]}.`; }
    if (id === "freeze") { g.frozen = { col: c, player: opp(p) }; ev = { type: "freeze", c }; note = `Player ${p} froze column ${L[c]}.`; }
    if (id === "lift") { const t2 = topDisc(g, c); ev = { type: "lift", r: t2, c, v: g.grid[t2][c] }; g.grid[t2][c] = 0; g.anc[t2][c] = false; note = `Player ${p} lifted a disc from ${L[c]}.`; }
    if (id === "pop") { ev = { type: "pop", c, prev: clone(g) }; const f = floorRow(g); g.grid[f][c] = 0; g.anc[f][c] = false; compactCol(g, c); g.last = null; note = `Player ${p} popped column ${L[c]}.`; }
    if (id === "reinforce") { ev = reinforce(g, c, p); note = `Player ${p} reinforced column ${L[c]}.`; }
    if (id === "flip") { ev = { type: "flip", c, prev: clone(g) }; flipCol(g, c); g.last = null; note = `Player ${p} flipped column ${L[c]}.`; }
    if (id === "anchor") { g.anc[a.r][a.c] = true; ev = { type: "anchor", r: a.r, c: a.c }; note = `Player ${p} anchored a disc.`; }
    if (id === "swap") {
      [g.grid[a.r][a.c], g.grid[a.r2][a.c2]] = [g.grid[a.r2][a.c2], g.grid[a.r][a.c]];
      ev = { type: "swap", r: a.r, c: a.c, r2: a.r2, c2: a.c2 };
      g.last = null; note = `Player ${p} swapped two discs.`;
    }
    if (id === "grenade") { const r = topEmpty(g, c); placeGrenade(g, r, c, Date.now()); g.last = { r, c }; ev = { type: "block", r, c }; note = `Player ${p} dropped a grenade in ${L[c]}.`; }
    if (id === "gravity") { ev = { type: "gravity", prev: clone(g) }; flipGravity(g); note = `Player ${p} flipped gravity. Discs now fall ${up(g) ? "up" : "down"}.`; }
    if (id === "double") { g.dd = true; g.dropsLeft = 2; note = `Player ${p} used Double Drop.`; }
    g.ev = ev; g.seq++; g.note = note;
    if (resolve(g)) return null;
    if (!anyDrop(g)) { endTurn(g); g.note = note + ` Player ${p} has no open column, so the turn ends.` + g.note; }
    return null;
  }

  // Grenades sit on the board as value 4; their id rides in the anc slot so it moves with the disc.
  const FUSE_MS = 2000;
  function placeGrenade(g, r, c, now) {
    g.bombSeq = (g.bombSeq || 0) + 1;
    g.grid[r][c] = 4; g.anc[r][c] = g.bombSeq;
    (g.bombs = g.bombs || []).push({ id: g.bombSeq, until: now + FUSE_MS });
  }
  // Explode one grenade: destroy it and its four orthogonal neighbours, then let the board settle.
  function detonate(g, id) {
    let at = null;
    for (let r = 0; r < ROWS && !at; r++) for (let c = 0; c < COLS; c++) if (g.grid[r][c] === 4 && g.anc[r][c] === id) { at = [r, c]; break; }
    g.bombs = (g.bombs || []).filter(b => b.id !== id);
    if (!at) return null;
    const [r, c] = at, prev = clone(g), cells = [r + "," + c];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc;
      if (inB(rr, cc) && g.grid[rr][cc] && g.grid[rr][cc] !== 4) cells.push(rr + "," + cc);
    }
    for (const k of cells) { const [a, b] = k.split(",").map(Number); g.grid[a][b] = 0; g.anc[a][b] = false; }
    for (let cc = 0; cc < COLS; cc++) compactCol(g, cc);
    g.last = null;
    return { type: "boom", r, c, prev, clears: [{ p: 0, cells }] };
  }
  // Tactics: called by the host's ticker.
  function tickBombs(g, now) {
    if (g.over || !g.bombs || !g.bombs.length) return false;
    const due = g.bombs.find(b => b.until <= now);
    if (!due) return false;
    const ev = detonate(g, due.id);
    if (!ev) return false;
    g.note = "A grenade exploded.";
    g.ev = ev; g.seq++;
    resolve(g);
    return true;
  }

  // Reverse gravity: every disc slides to the other side (keeping its order) and new discs come from that side.
  function flipGravity(g) {
    const before = [...Array(COLS).keys()].map(c => segs(g, c).map(sg => [sg, segStack(g, c, sg).reverse()]));
    g.gdir = up(g) ? 1 : -1;
    before.forEach((list, c) => list.forEach(([sg, s]) => writeSeg(g, c, sg, s)));
    g.last = null;
  }

  // Insert the player's disc at the floor end of the column, pushing the stretch's discs one step away from the floor.
  function reinforce(g, c, p) {
    const sg = floorSeg(g, c), list = segStack(g, c, sg);
    const ev = { type: "reinforce", c, n: list.length + 1, gdir: g.gdir || 1 };
    writeSeg(g, c, sg, [[p, false], ...list]);
    g.last = { r: floorRow(g), c };
    return ev;
  }

  function timeout(g) {
    if (g.over) return;
    const p = g.cur;
    g.energy[p] = Math.max(0, g.energy[p] - g.gained);
    g.note = `Player ${p} ran out of time: no drop, no energy.`;
    g.ev = { type: "timeout" }; g.seq++;
    endTurn(g);
  }

  const api = { ROWS, COLS, MAXE, TURN_S, L, AB, opp, newGame, canDrop, drop, ability, timeout, validCol, validCell, hasTarget, abilityReady, count,
    FIXED, segs, compactCol, flipCol, reinforce, floorSeg,
    lines, topEmpty, topDisc, floorRow, isFull, flipGravity, up, stack, writeStack, clone, partner, blank, placeGrenade, detonate, tickBombs, FUSE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CW = api;
})(typeof window !== "undefined" ? window : globalThis);
