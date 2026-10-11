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
    gravity:{ name: "Gravity Flip", cost: 6, t: "none", desc: "Reverse gravity: every column turns upside down at once." }
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

  const topEmpty = (g, c) => { for (let r = ROWS - 1; r >= 0; r--) if (!g.grid[r][c]) return r; return -1; };
  const topDisc = (g, c) => { for (let r = 0; r < ROWS; r++) if (g.grid[r][c]) return r; return -1; };
  const count = (g, c) => g.grid.reduce((n, row) => n + (row[c] ? 1 : 0), 0);
  function stack(g, c) { const s = []; for (let r = ROWS - 1; r >= 0; r--) if (g.grid[r][c]) s.push([g.grid[r][c], g.anc[r][c]]); return s; }
  function writeStack(g, c, s) {
    for (let r = 0; r < ROWS; r++) { g.grid[r][c] = 0; g.anc[r][c] = false; }
    s.forEach(([v, a], i) => { g.grid[ROWS - 1 - i][c] = v; g.anc[ROWS - 1 - i][c] = a; });
  }
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
    if (g.grid[0].every(v => v)) return finish(g, 0, []);
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
      case "block": case "freeze": return topEmpty(g, c) >= 0;
      case "lift": { const t = topDisc(g, c); return t >= 0 && g.grid[t][c] === p; }
      case "pop": return g.grid[ROWS - 1][c] === opp(p) && !g.anc[ROWS - 1][c];
      case "flip": return count(g, c) >= 2;
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
    if (id === "pop") { ev = { type: "pop", c, prev: clone(g) }; g.grid[ROWS - 1][c] = 0; g.anc[ROWS - 1][c] = false; writeStack(g, c, stack(g, c)); g.last = null; note = `Player ${p} popped column ${L[c]}.`; }
    if (id === "flip") { ev = { type: "flip", c, prev: clone(g) }; writeStack(g, c, stack(g, c).reverse()); g.last = null; note = `Player ${p} flipped column ${L[c]}.`; }
    if (id === "anchor") { g.anc[a.r][a.c] = true; ev = { type: "anchor", r: a.r, c: a.c }; note = `Player ${p} anchored a disc.`; }
    if (id === "swap") {
      [g.grid[a.r][a.c], g.grid[a.r2][a.c2]] = [g.grid[a.r2][a.c2], g.grid[a.r][a.c]];
      ev = { type: "swap", r: a.r, c: a.c, r2: a.r2, c2: a.c2 };
      g.last = null; note = `Player ${p} swapped two discs.`;
    }
    if (id === "gravity") { ev = { type: "gravity", prev: clone(g) }; for (let cc = 0; cc < COLS; cc++) writeStack(g, cc, stack(g, cc).reverse()); g.last = null; note = `Player ${p} flipped gravity.`; }
    if (id === "double") { g.dd = true; g.dropsLeft = 2; note = `Player ${p} used Double Drop.`; }
    g.ev = ev; g.seq++; g.note = note;
    if (resolve(g)) return null;
    if (!anyDrop(g)) { endTurn(g); g.note = note + ` Player ${p} has no open column, so the turn ends.` + g.note; }
    return null;
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
    lines, topEmpty, topDisc, stack, writeStack, clone, partner, blank };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CW = api;
})(typeof window !== "undefined" ? window : globalThis);
