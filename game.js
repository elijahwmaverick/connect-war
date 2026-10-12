// Connect War rules engine. Shared by the server (authoritative) and the browser (for highlighting targets).
(function (root) {
  // Board size is per game (2 players: 8×7, 3 players: 10×8); setDims switches it for whichever game is active.
  let ROWS = 7, COLS = 8, L = "ABCDEFGH";
  const MAXE = 7, TURN_S = 20, TARGET = 3; // first to 3 fours wins
  function setDims(rows, cols) { ROWS = rows; COLS = cols; L = "ABCDEFGHIJKL".slice(0, cols); }
  // Disc values: player 1 = 1, player 2 = 2, player 3 = 6 (3, 4, 5 are stone, grenade, fixed stone).
  const PV = p => (p === 3 ? 6 : p);
  const isDisc = v => v === 1 || v === 2 || v === 6;
  const nextP = (g, p) => (p % (g.n || 2)) + 1;
  const others = (g, p) => [...Array(g.n || 2).keys()].map(i => i + 1).filter(x => x !== p);
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
    reinforce:{ name: "Reinforce", cost: 3, t: "col",  desc: "Slide your disc into the floor end of a column, pushing the stack away from the floor. Ends your turn." },
    punch:  { name: "Punch In",    cost: 3, t: "cell", desc: "Punch your disc into any cell that isn't an enemy disc. It can replace a stone, a fixed stone or a grenade. Ends your turn." },
    rotate: { name: "Rotate",      cost: 5, t: "dir",  only: "tactics", desc: "Turn the board 90° left or right. That side becomes the floor and every disc falls." },
    shift:  { name: "Shift",       cost: 3, t: "row",  only: "tactics", desc: "Slide every disc in a row one space left or right. The end disc wraps around; fixed stones stay put." },
    insert: { name: "Insert",      cost: 2, t: "side", desc: "Slide your disc in from the left or right edge of a row. It stops at the first occupied cell or the far wall, then falls. Ends your turn." },
    flask:  { name: "Stone Flask", cost: 3, t: "cell", desc: "Throw a flask in from the left or right edge to any empty cell it can reach along its row. It shatters there and turns the empty cells above, below, left and right of it into fixed stone. Ends your turn." },
    gravity:{ name: "Gravity Flip", cost: 6, t: "none", desc: "Reverse gravity. All discs fly to the other side, and new discs come from there until it's flipped again." }
  };
  const opp = p => 3 - p; // 2-player shorthand (Full Auto)
  const blank = v => Array.from({ length: ROWS }, () => Array(COLS).fill(v));
  const clone = g => ({ grid: g.grid.map(r => r.slice()), anc: g.anc.map(r => r.slice()), rows: g.grid.length, cols: g.grid[0].length, gdir: g.gdir || 1 });

  const frozenOn = (f, p) => (f.players ? f.players.includes(p) : f.player === p);
  function newGame(starter, opts = {}) {
    const n = opts.players === 3 ? 3 : 2;
    if (n === 3) setDims(8, 10); else setDims(7, 8);
    // Later seats start with a little energy to offset moving later.
    const energy = {}; for (let i = 0, p = starter; i < n; i++, p = (p % n) + 1) energy[p] = i;
    const g = {
      n, rows: ROWS, cols: COLS,
      grid: blank(0), anc: blank(false), cur: starter,
      energy, score: {},
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
  // A drop travels in from the entry side; the first fixed stone it meets shatters and it keeps going.
  function landing(g, c) {
    const u = up(g), step = u ? -1 : 1, start = u ? ROWS - 1 : 0, end = u ? -1 : ROWS;
    let broke = null;
    for (let r = start; r !== end; r += step) {
      const v = g.grid[r][c];
      if (!v) continue;
      if (v === FIXED && broke === null) { broke = r; continue; }
      return { r: r === start ? -1 : r - step, broke };
    }
    return { r: end - step, broke };
  }
  const columnOpen = (g, c) => { const l = landing(g, c); return l.r >= 0 || l.broke !== null; };
  const isFull = g => { for (let c = 0; c < COLS; c++) if (columnOpen(g, c)) return false; return true; };
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
        if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || g.grid[rr][cc] !== PV(p)) break;
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
    if (g.gravRevert && g.gravRevert.by === g.cur && --g.gravRevert.left <= 0) g.revertAt = Date.now() + 650; // host's ticker flips it back
    if (!anyDrop(g)) {
      const p = g.cur;
      endTurn(g);
      g.note += ` Player ${p} had no open column, so the turn was skipped.`;
    }
  }
  function endTurn(g) {
    if (g.frozen) {
      g.frozen.players = (g.frozen.players || [g.frozen.player]).filter(x => x !== g.cur);
      if (!g.frozen.players.length) g.frozen = null;
    }
    g.cur = nextP(g, g.cur);
    startTurn(g);
  }
  function finish(g, w, cells) {
    g.over = true; g.result = w; g.win = cells;
    g.note = w ? `Player ${w} wins with ${(g.score && g.score[w]) || 1} fours.` : "Draw.";
    return true;
  }
  // Every completed four scores a point and turns into fixed stones. First to TARGET wins
  // (if two players get there on the same move, the player who moved wins). A board with no
  // open column is wiped. Returns true when the match ended.
  function resolve(g) {
    g.score = g.score || {};
    const order = [g.cur]; for (let i = 1, p = nextP(g, g.cur); i < (g.n || 2); i++, p = nextP(g, p)) order.push(p);
    const scores = [];
    for (const p of order) { const cells = lines(g, p); if (cells.length) scores.push({ p, cells }); }
    if (scores.length) {
      for (const sc of scores) {
        for (const k of sc.cells) { const [r, c] = k.split(",").map(Number); g.grid[r][c] = FIXED; g.anc[r][c] = false; }
        g.score[sc.p] = (g.score[sc.p] || 0) + 1;
      }
      g.last = null;
      if (g.ev) g.ev.scores = scores;
      g.note += ` ${scores.map(sc => `Player ${sc.p}`).join(" and ")} scored!`;
      const best = Math.max(...order.map(p => g.score[p] || 0));
      if (best >= TARGET) {
        const w = order.find(p => (g.score[p] || 0) === best);
        const won = scores.find(sc => sc.p === w);
        return finish(g, w, won ? won.cells : []);
      }
    }
    if (isFull(g)) {
      g.grid = blank(0); g.anc = blank(false); g.bombs = []; g.last = null;
      if (g.ev) g.ev.wipe = true;
      g.note += " Board full, so it was wiped.";
    }
    return false;
  }

  function canDrop(g, c) {
    if (c < 0 || c >= COLS || !columnOpen(g, c)) return false;
    const f = g.frozen;
    if (f && frozenOn(f, g.cur) && f.col === c) return false;
    if (g.dd && g.dropsMade === 1) {
      if (c === g.firstCol) return false;
      const l = landing(g, c), saved = l.broke !== null ? g.grid[l.broke][c] : null;
      if (l.broke !== null) g.grid[l.broke][c] = 0;
      const r = l.r >= 0 ? l.r : l.broke;
      g.grid[r][c] = PV(g.cur); const w = lines(g, g.cur).length > 0; g.grid[r][c] = 0;
      if (l.broke !== null) g.grid[l.broke][c] = saved;
      if (w) return false;
    }
    return true;
  }
  function anyDrop(g) { for (let c = 0; c < COLS; c++) if (canDrop(g, c)) return true; return false; }

  // Returns an error string, or null on success.
  function drop(g, c) {
    if (g.over) return "The match is over.";
    if (g.revertAt) return "Gravity is flipping back…";
    if (g.awaitBomb) return "Wait for the grenade to explode.";
    if (!canDrop(g, c)) {
      const f = g.frozen;
      if (f && frozenOn(f, g.cur) && f.col === c) return `Column ${L[c]} is frozen this turn.`;
      if (!columnOpen(g, c)) return `Column ${L[c]} is full.`;
      if (c === g.firstCol) return "The second disc must go in a different column.";
      return "The second Double Drop disc can't complete a 4.";
    }
    const p = g.cur, l = landing(g, c);
    if (l.broke !== null) { g.grid[l.broke][c] = 0; g.anc[l.broke][c] = false; }
    const r = l.r >= 0 ? l.r : l.broke;
    g.grid[r][c] = PV(p); g.last = { r, c };
    g.ev = { type: "drop", r, c }; if (l.broke !== null) g.ev.broke = l.broke;
    g.seq++;
    g.note = `Player ${p} dropped in ${L[c]}${l.broke !== null ? " and smashed a stone" : ""}.`;
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
      case "grenade": return columnOpen(g, c);
      case "lift": { const t = topDisc(g, c); return t >= 0 && g.grid[t][c] === PV(p); }
      case "pop": { const f = floorRow(g); const v = g.grid[f][c]; return isDisc(v) && v !== PV(p) && !g.anc[f][c]; }
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
    return isDisc(a) && !g.anc[r1][c1] && isDisc(b) && a !== b && !g.anc[r2][c2];
  }
  function swapFirst(g, r, c) {
    if (!inB(r, c)) return false;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => partner(g, r, c, r + dr, c + dc));
  }
  function validCell(g, id, r, c, sel) {
    if (!inB(r, c)) return false;
    if (id === "anchor") return g.grid[r][c] === PV(g.cur) && !g.anc[r][c];
    if (id === "punch") return [0, 3, 4, FIXED].includes(g.grid[r][c]);
    if (id === "shift") return rowMovable(g, r);
    if (id === "insert") return sideOpen(g, r, "left") || sideOpen(g, r, "right");
    if (id === "flask") return !!flaskSide(g, r, c);
    if (id === "swap") return sel ? partner(g, sel[0], sel[1], r, c) : swapFirst(g, r, c);
    return false;
  }
  function hasTarget(g, id) {
    const t = AB[id].t;
    if (t === "col") { for (let c = 0; c < COLS; c++) if (validCol(g, id, c)) return true; return false; }
    if (t === "row") { for (let r = 0; r < ROWS; r++) if (rowMovable(g, r)) return true; return false; }
    if (t === "side") { for (let r = 0; r < ROWS; r++) if (validCell(g, id, r, 0)) return true; return false; }
    if (t === "own" || t === "pair" || t === "cell") {
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
    if (g.revertAt) return "Gravity is flipping back…";
    if (g.awaitBomb) return "Wait for the grenade to explode.";
    if (!abilityReady(g, id, loadout)) return `${AB[id].name} isn't available right now.`;
    const p = g.cur, nm = AB[id].name, t = AB[id].t;
    if (t === "col" && !validCol(g, id, a.c)) return `Not a valid column for ${nm}.`;
    if (id === "anchor" && !validCell(g, id, a.r, a.c)) return "Pick one of your own unanchored discs.";
    if (id === "swap" && !partner(g, a.r, a.c, a.r2, a.c2)) return "Pick two adjacent, unanchored discs of different colors.";
    if (id === "punch" && !validCell(g, id, a.r, a.c)) return "Punch In can't target a player's disc.";
    if ((id === "rotate" || id === "shift") && a.dir !== "left" && a.dir !== "right") return "Pick left or right.";
    if (id === "shift" && !rowMovable(g, a.r)) return "That row has nothing to shift.";
    if (id === "insert" && !sideOpen(g, a.r, a.dir)) return "That edge of the row is blocked.";
    if (id === "flask" && !flaskSide(g, a.r, a.c)) return "The flask can't reach that cell.";

    g.energy[p] -= AB[id].cost; g.abilityUsed = true;
    const c = a.c;
    let ev = { type: id }, note = "";
    if (id === "block") { const r = topEmpty(g, c); g.grid[r][c] = 3; g.anc[r][c] = "o" + p; g.last = { r, c }; ev = { type: "block", r, c }; note = `Player ${p} placed a stone in ${L[c]}.`; }
    if (id === "freeze") { g.frozen = { col: c, players: others(g, p), by: p }; ev = { type: "freeze", c }; note = `Player ${p} froze column ${L[c]}.`; }
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
    if (id === "grenade") { ev = dropGrenade(g, c, Date.now(), p); note = `Player ${p} dropped a grenade in ${L[c]}${ev.broke !== undefined ? " and smashed a stone" : ""}.`; }
    if (id === "punch") {
      if (g.grid[a.r][c] === 4) g.bombs = (g.bombs || []).filter(b => b.id !== g.anc[a.r][c]);
      g.grid[a.r][c] = PV(p); g.anc[a.r][c] = "punch";
      compactCol(g, c);
      let r2 = a.r; for (let r = 0; r < ROWS; r++) if (g.anc[r][c] === "punch") { r2 = r; g.anc[r][c] = false; }
      g.last = { r: r2, c }; ev = { type: "punch", r: r2, c, from: a.r };
      note = `Player ${p} punched in a disc at ${L[c]}${ROWS - a.r}.`;
    }
    if (id === "gravity") {
      ev = { type: "gravity", prev: clone(g) }; flipGravity(g);
      g.gravRevert = up(g) ? { by: p, left: 3 } : null; g.revertAt = null;
      note = up(g) ? `Player ${p} flipped gravity. Discs fall up until the start of Player ${p}'s third turn from now.` : `Player ${p} flipped gravity back down.`;
    }
    if (id === "rotate") { const prev = clone(g); rotateBoard(g, a.dir); const mid = clone(g); for (let cc = 0; cc < COLS; cc++) compactCol(g, cc); g.last = null; ev = { type: "rotate", dir: a.dir, prev, mid }; note = `Player ${p} rotated the board ${a.dir}.`; }
    if (id === "insert") { ev = insertFromSide(g, a.r, a.dir, PV(p)); note = `Player ${p} inserted a disc from the ${a.dir} into row ${ROWS - a.r}.`; }
    if (id === "flask") { ev = throwFlask(g, a.r, a.c); note = `Player ${p} threw a Stone Flask into ${L[a.c]}${ROWS - a.r}.`; }
    if (id === "shift") { const prev = clone(g); shiftRow(g, a.r, a.dir); const mid = clone(g); for (let cc = 0; cc < COLS; cc++) compactCol(g, cc); g.last = null; ev = { type: "shift", r: a.r, dir: a.dir, prev, mid }; note = `Player ${p} shifted row ${ROWS - a.r} ${a.dir}.`; }
    if (id === "double") { g.dd = true; g.dropsLeft = 2; note = `Player ${p} used Double Drop.`; }
    ev.ability = id; ev.by = p;
    g.ev = ev; g.seq++; g.note = note;
    if (resolve(g)) return null;
    if (id === "grenade") { g.awaitBomb = g.bombSeq; return null; } // the turn ends when it explodes (host ticker)
    if (id === "insert" || id === "flask" || id === "reinforce" || id === "punch") { endTurn(g); return null; } // these replace your drop and end the turn
    if (!anyDrop(g)) { endTurn(g); g.note = note + ` Player ${p} has no open column, so the turn ends.` + g.note; }
    return null;
  }

  // Grenades sit on the board as value 4; their id rides in the anc slot so it moves with the disc.
  const FUSE_MS = 2000;
  function placeGrenade(g, r, c, now, by) {
    g.bombSeq = (g.bombSeq || 0) + 1;
    g.grid[r][c] = 4; g.anc[r][c] = g.bombSeq;
    (g.bombs = g.bombs || []).push({ id: g.bombSeq, until: now + FUSE_MS, by });
  }
  // A grenade falls like a disc: it smashes the first fixed stone it meets, lands, and its fuse starts.
  function dropGrenade(g, c, now, by) {
    const l = landing(g, c);
    if (l.broke !== null) { g.grid[l.broke][c] = 0; g.anc[l.broke][c] = false; }
    const r = l.r >= 0 ? l.r : l.broke;
    placeGrenade(g, r, c, now, by); g.last = { r, c };
    const ev = { type: "block", r, c };
    if (l.broke !== null) ev.broke = l.broke;
    return ev;
  }
  // Explode one grenade: destroy it and its four orthogonal neighbours, then let the board settle.
  function detonate(g, id) {
    let at = null;
    for (let r = 0; r < ROWS && !at; r++) for (let c = 0; c < COLS; c++) if (g.grid[r][c] === 4 && g.anc[r][c] === id) { at = [r, c]; break; }
    const bomb = (g.bombs || []).find(b => b.id === id);
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
    return { type: "boom", r, c, prev, clears: [{ p: 0, cells }], by: bomb && bomb.by };
  }
  // Tactics: called by the host's ticker.
  function tickBombs(g, now) {
    if (!g.over && g.revertAt && now >= g.revertAt) {
      const ev = { type: "gravity", prev: clone(g), auto: true };
      flipGravity(g); g.gravRevert = null; g.revertAt = null;
      g.note = "Gravity flipped back down.";
      g.ev = ev; g.seq++;
      resolve(g);
      return true;
    }
    if (g.over) return false;
    // The thrower's turn ends once their grenade has gone off (or if it vanished, e.g. a board wipe).
    const passTurn = () => { if (g.awaitBomb) { g.awaitBomb = null; if (!g.over) endTurn(g); } };
    if (g.awaitBomb && !(g.bombs || []).some(b => b.id === g.awaitBomb)) { passTurn(); g.ev = { type: "turn" }; g.seq++; return true; }
    if (!g.bombs || !g.bombs.length) return false;
    const due = g.bombs.find(b => b.until <= now);
    if (!due) return false;
    const ev = detonate(g, due.id);
    if (!ev) { if (due.id === g.awaitBomb) { passTurn(); g.ev = { type: "turn" }; g.seq++; return true; } return false; }
    g.note = "A grenade exploded.";
    g.ev = ev; g.seq++;
    resolve(g);
    if (due.id === g.awaitBomb) passTurn();
    return true;
  }

  // Rotate the whole board 90°. "right" = clockwise (the right side becomes the floor), "left" = counter-clockwise.
  // Rows and columns swap; nothing settles here (the caller lets discs fall afterwards). Freezes are cleared.
  function rotateBoard(g, dir) {
    const R = ROWS, C = COLS, grid = [], anc = [];
    for (let r = 0; r < C; r++) {
      grid.push([]); anc.push([]);
      for (let c = 0; c < R; c++) {
        const [sr, sc] = dir === "right" ? [R - 1 - c, r] : [c, C - 1 - r];
        grid[r].push(g.grid[sr][sc]); anc[r].push(g.anc[sr][sc]);
      }
    }
    g.grid = grid; g.anc = anc; g.rows = C; g.cols = R; setDims(C, R);
    g.frozen = null; g.firstCol = null;
  }
  // Can row r be shifted? (it has at least one piece that isn't a fixed stone, and somewhere to move)
  function rowMovable(g, r) {
    if (r < 0 || r >= ROWS) return false;
    let pieces = 0, slots = 0;
    for (let c = 0; c < COLS; c++) { const v = g.grid[r][c]; if (v !== FIXED) { slots++; if (v) pieces++; } }
    return pieces > 0 && slots > 1;
  }
  // Insert path: the piece enters row r from one side and slides until something stops it.
  //  - the first fixed stone it meets shatters and it keeps going;
  //  - a movable piece with an empty cell right behind it is knocked one step and the inserted piece takes its spot (once);
  //  - otherwise it stops in front of whatever it hits (or at the far wall).
  // Returns { pos, broke, knock } or null when nothing can enter from that side.
  function insertPath(g, r, side) {
    if (r < 0 || r >= ROWS || (side !== "left" && side !== "right")) return null;
    const step = side === "left" ? 1 : -1;
    let pos = side === "left" ? -1 : COLS, broke = null, knock = null;
    for (;;) {
      const nx = pos + step;
      if (nx < 0 || nx >= COLS) break;
      const v = g.grid[r][nx];
      if (!v || nx === broke) { pos = nx; continue; }
      if (v === FIXED && broke === null) { broke = nx; pos = nx; continue; }
      const beyond = nx + step;
      if (v !== FIXED && beyond >= 0 && beyond < COLS && (!g.grid[r][beyond] || beyond === broke)) { knock = { from: nx, to: beyond }; pos = nx; }
      break;
    }
    if (pos < 0 || pos >= COLS) return null;
    return { pos, broke, knock };
  }
  const sideOpen = (g, r, side) => !!insertPath(g, r, side);

  // Stone Flask: thrown in from an edge along a row through empty cells, so it can burst at any
  // empty cell with a clear line to the left or right edge (the nearer edge when both are clear).
  function flaskSide(g, r, c) {
    if (!inB(r, c) || g.grid[r][c]) return null;
    let left = true, right = true;
    for (let x = 0; x < c; x++) if (g.grid[r][x]) { left = false; break; }
    for (let x = c + 1; x < COLS; x++) if (g.grid[r][x]) { right = false; break; }
    if (left && right) return c <= COLS - 1 - c ? "left" : "right";
    return left ? "left" : right ? "right" : null;
  }
  // The burst turns the empty cells around it into fixed stone; pieces already there stay.
  function throwFlask(g, r, c) {
    const side = flaskSide(g, r, c), stones = [];
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const rr = r + dr, cc = c + dc;
      if (inB(rr, cc) && !g.grid[rr][cc]) { g.grid[rr][cc] = FIXED; g.anc[rr][cc] = false; stones.push([rr, cc]); }
    }
    g.last = null;
    return { type: "flask", r, c, side, stones };
  }
  // Slide a piece in from the side (breaking / knocking as above), then let everything fall.
  function insertFromSide(g, r, side, value) {
    const prev = clone(g), path = insertPath(g, r, side);
    const c = path.pos;
    if (path.broke !== null) { g.grid[r][path.broke] = 0; g.anc[r][path.broke] = false; }
    if (path.knock) {
      const { from, to } = path.knock;
      g.grid[r][to] = g.grid[r][from]; g.anc[r][to] = g.anc[r][from];
      g.grid[r][from] = 0; g.anc[r][from] = false;
    }
    g.grid[r][c] = value; g.anc[r][c] = "ins";
    const mid = clone(g); mid.anc[r][c] = false;
    compactCol(g, c);
    let r2 = r; for (let rr = 0; rr < ROWS; rr++) if (g.anc[rr][c] === "ins") { r2 = rr; g.anc[rr][c] = false; }
    g.last = { r: r2, c };
    if (path.knock) compactCol(g, path.knock.to);
    if (path.broke !== null && path.broke !== c) compactCol(g, path.broke); // pieces resting on the shattered stone fall
    return { type: "insert", r, c, side, r2, prev, mid, broke: path.broke, knock: path.knock };
  }
  // Slide every movable piece in row r one step; the end piece wraps around. Fixed stones stay put.
  function shiftRow(g, r, dir) {
    const cols = []; for (let c = 0; c < COLS; c++) if (g.grid[r][c] !== FIXED) cols.push(c);
    const vals = cols.map(c => [g.grid[r][c], g.anc[r][c]]);
    const moved = dir === "right" ? [vals[vals.length - 1], ...vals.slice(0, -1)] : [...vals.slice(1), vals[0]];
    cols.forEach((c, i) => { g.grid[r][c] = moved[i][0]; g.anc[r][c] = moved[i][1]; });
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
    writeSeg(g, c, sg, [[PV(p), false], ...list]);
    g.last = { r: floorRow(g), c };
    return ev;
  }

  function timeout(g) {
    if (g.over || g.awaitBomb) return;
    const p = g.cur;
    g.energy[p] = Math.max(0, g.energy[p] - g.gained);
    g.note = `Player ${p} ran out of time: no drop, no energy.`;
    g.ev = { type: "timeout" }; g.seq++;
    endTurn(g);
  }

  const api = { get ROWS() { return ROWS; }, get COLS() { return COLS; }, get L() { return L; }, setDims, PV, isDisc, nextP, others,
    MAXE, TURN_S, AB, opp, newGame, canDrop, drop, ability, timeout, validCol, validCell, hasTarget, abilityReady, count,
    FIXED, segs, compactCol, flipCol, reinforce, floorSeg,
    TARGET, landing, columnOpen, dropGrenade, insertPath, flaskSide, throwFlask, rotateBoard, shiftRow, rowMovable, sideOpen, insertFromSide,
    lines, topEmpty, topDisc, floorRow, isFull, flipGravity, up, stack, writeStack, clone, partner, blank, placeGrenade, detonate, tickBombs, FUSE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CW = api;
})(typeof window !== "undefined" ? window : globalThis);
