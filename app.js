// Connect War over Supabase Realtime.
// The host's browser owns the match (rules, clock, picks) and broadcasts the board.
// The guest sends taps to the host and draws whatever the host sends back.
const { ROWS, COLS, MAXE, TURN_S, L, AB, opp } = CW;
const app = document.getElementById("app");

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch (e) { return null; }
}
let token = store("cw_token");
if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store("cw_token", token); }

const cfg = window.CW_CONFIG || {};
const configured = cfg.SUPABASE_URL && !/YOUR-PROJECT/.test(cfg.SUPABASE_URL) && cfg.SUPABASE_ANON_KEY && !/PASTE-YOUR/.test(cfg.SUPABASE_ANON_KEY);
const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

/* ================= transport ================= */
let channel = null, isHost = false, code = null, peerOnline = false, joinTimer = null;
const pending = new Map(); let reqId = 0;

function openChannel(c, host) {
  closeChannel();
  code = c; isHost = host; peerOnline = false;
  channel = sb.channel("cw-" + c, { config: { broadcast: { self: false }, presence: { key: token } } });
  channel
    .on("broadcast", { event: "state" }, ({ payload }) => { if (!isHost && payload.to === token) onView(payload.view); })
    .on("broadcast", { event: "ack" }, ({ payload }) => {
      if (isHost || payload.to !== token) return;
      const cb = pending.get(payload.id); pending.delete(payload.id); cb && cb(payload.res);
    })
    .on("broadcast", { event: "reject" }, ({ payload }) => {
      if (!isHost && payload.to === token) { leaveLocal(); err = payload.reason; render(); }
    })
    .on("broadcast", { event: "closed" }, () => {
      if (!isHost) { leaveLocal(); err = "The host closed the game."; render(); }
    })
    .on("broadcast", { event: "hello" }, ({ payload }) => { if (isHost) hostHello(payload.token); })
    .on("broadcast", { event: "action" }, ({ payload }) => { if (isHost) hostAction(payload); })
    .on("presence", { event: "sync" }, () => {
      const was = peerOnline;
      computePeer();
      if (isHost) { if (room && peerOnline !== was) publish(); }
      else if (V) { V.opponentConnected = peerOnline; render(); }
    })
    .subscribe(async status => {
      if (status === "SUBSCRIBED") {
        err = "";
        await channel.track({ token, seat: isHost ? 1 : 2 });
        if (isHost) publish(); else sayHello();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        err = "Can't reach the game server. Check your connection."; render();
      }
    });
}
function computePeer() {
  if (!channel) { peerOnline = false; return; }
  const others = Object.values(channel.presenceState()).flat().filter(p => p.token !== token);
  peerOnline = others.some(p => (isHost ? p.seat === 2 && room && p.token === room.guest : p.seat === 1));
}
function closeChannel() {
  if (joinTimer) { clearInterval(joinTimer); joinTimer = null; }
  if (channel) { sb.removeChannel(channel); channel = null; }
}
function send(event, payload) { if (channel) channel.send({ type: "broadcast", event, payload }); }

// Guest: keep knocking until the host answers.
function sayHello() {
  let tries = 0;
  const knock = () => {
    if (V) { clearInterval(joinTimer); joinTimer = null; return; }
    send("hello", { token });
    if (++tries === 3) { err = `Waiting for the host of game ${code} to come online…`; render(); }
  };
  knock();
  joinTimer = setInterval(knock, 2000);
}

/* ================= host: authoritative room ================= */
let room = null, hostTimer = null;

function newRoom(c, timerOn) {
  return { code: c, guest: null, phase: "lobby", picks: { 1: null, 2: null }, starter: 1, game: null,
    timerOn: !!timerOn, deadline: null, timerTurn: null, votes: { rematch: [], redraft: [] } };
}
function saveRoom() { if (room) store("cw_host_" + room.code, JSON.stringify(room)); }

function view(seat) {
  const other = opp(seat);
  const both = !!(room.picks[1] && room.picks[2]);
  return {
    code: room.code, seat, phase: room.phase, timerOn: room.timerOn,
    opponentJoined: seat === 1 ? !!room.guest : true,
    opponentConnected: seat === 1 ? peerOnline : true,
    myPicks: room.picks[seat], oppLocked: !!room.picks[other], oppPicks: both ? room.picks[other] : null,
    starter: room.starter, game: room.game,
    timeLeftMs: room.deadline && room.game && !room.game.over ? Math.max(0, room.deadline - Date.now()) : null,
    votes: room.votes
  };
}
function publish() {
  if (!room) return;
  saveRoom();
  if (room.guest) send("state", { to: room.guest, view: view(2) });
  onView(JSON.parse(JSON.stringify(view(1))));
}

function clearTimer() { if (hostTimer) clearTimeout(hostTimer); hostTimer = null; }
function armTimer(extraMs = 0) {
  const g = room.game;
  if (!room.timerOn || !g || g.over) { clearTimer(); room.deadline = null; return; }
  if (room.timerTurn === g.turnId && !extraMs && hostTimer) return;
  const sameTurn = room.timerTurn === g.turnId && room.deadline;
  const remaining = sameTurn ? room.deadline - Date.now() : TURN_S * 1000;
  clearTimer();
  room.timerTurn = g.turnId;
  room.deadline = Date.now() + Math.max(0, remaining) + extraMs;
  hostTimer = setTimeout(() => {
    hostTimer = null;
    if (!room || !room.game || room.game.over) return;
    CW.timeout(room.game);
    armTimer();
    publish();
  }, room.deadline - Date.now());
}
function startMatch() {
  room.phase = "play";
  room.game = CW.newGame(room.starter);
  room.votes = { rematch: [], redraft: [] };
  room.timerTurn = null; room.deadline = null; clearTimer();
  armTimer();
}

// Returns an error string or null. Mutates room, caller publishes.
function handle(seat, type, p) {
  p = p || {};
  if (type === "pick") {
    if (room.phase !== "draft") return "Picks are closed.";
    const ids = p.ids;
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || !ids.every(id => AB[id])) return "Pick exactly 3 different abilities.";
    if (room.picks[seat]) return "You already locked in.";
    room.picks[seat] = ids.slice();
    if (room.picks[1] && room.picks[2]) startMatch();
    return null;
  }
  if (type === "vote") {
    if (!room.game || !room.game.over) return null;
    const kind = p.kind; if (kind !== "rematch" && kind !== "redraft") return null;
    const other = kind === "rematch" ? "redraft" : "rematch";
    room.votes[other] = room.votes[other].filter(s => s !== seat);
    if (!room.votes[kind].includes(seat)) room.votes[kind].push(seat);
    if (room.votes[kind].length === 2) {
      room.starter = opp(room.starter);
      if (kind === "rematch") startMatch();
      else { room.phase = "draft"; room.picks = { 1: null, 2: null }; room.game = null; room.votes = { rematch: [], redraft: [] }; clearTimer(); room.deadline = null; }
    }
    return null;
  }
  if (type === "drop" || type === "ability") {
    const g = room.game;
    if (room.phase !== "play" || !g || g.over) return "No active match.";
    if (seat !== g.cur) return "It's not your turn.";
    let e;
    if (type === "drop") e = CW.drop(g, Number(p.c));
    else e = CW.ability(g, { id: p.id, c: Number(p.c), r: Number(p.r), r2: Number(p.r2), c2: Number(p.c2) }, room.picks[seat]);
    if (e) return e;
    if (g.over) { clearTimer(); room.deadline = null; } else armTimer(type === "ability" && (p.id === "flip" || p.id === "pop") ? 700 : 0);
    return null;
  }
  return "Unknown action.";
}

function hostHello(t) {
  if (!room) return;
  if (!room.guest) { room.guest = t; if (room.phase === "lobby") room.phase = "draft"; }
  else if (room.guest !== t) { send("reject", { to: t, reason: "That game already has two players." }); return; }
  computePeer();
  publish();
}
function hostAction(msg) {
  if (!room || msg.token !== room.guest) return;
  const e = handle(2, msg.type, msg.p);
  send("ack", { to: msg.token, id: msg.id, res: e ? { error: e } : { ok: true } });
  if (!e) publish();
}

/* ================= actions from this device ================= */
function act(type, p, cb) {
  if (isHost) {
    const e = handle(1, type, p);
    cb && cb(e ? { error: e } : { ok: true });
    if (!e) publish();
    return;
  }
  const id = ++reqId;
  if (cb) pending.set(id, cb);
  send("action", { token, id, type, p });
}

function createGame() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  room = newRoom(c, timerOn);
  store("cw_room", c); store("cw_role", "host");
  history.replaceState(null, "", "#" + c);
  openChannel(c, true);
  publish();
}
function resumeHost(c) {
  try { room = JSON.parse(store("cw_host_" + c)); } catch (e) { room = null; }
  if (!room) return false;
  store("cw_room", c); store("cw_role", "host");
  openChannel(c, true);
  if (room.game && !room.game.over) { room.timerTurn = null; if (room.deadline) { const left = room.deadline - Date.now(); room.deadline = Date.now() + Math.max(1000, left); room.timerTurn = room.game.turnId; } armTimer(); }
  publish();
  return true;
}
function joinGame(c) {
  c = c.trim().toUpperCase();
  if (store("cw_role") === "host" && store("cw_host_" + c) && resumeHost(c)) return;
  V = null; store("cw_room", c); store("cw_role", "guest");
  history.replaceState(null, "", "#" + c);
  err = "Connecting…"; render();
  openChannel(c, false);
}
function leaveLocal() {
  closeChannel();
  if (isHost && room) store("cw_host_" + room.code, null);
  clearTimer(); room = null; isHost = false; code = null; V = null;
  store("cw_room", null); store("cw_role", null);
  history.replaceState(null, "", location.pathname);
  sel = []; mode = null; lastSeq = -1;
}
function leave() {
  if (isHost) send("closed", {});
  setTimeout(() => { leaveLocal(); render(); }, isHost ? 150 : 0);
}

/* ================= view + rendering ================= */
let V = null, err = "", timerOn = true, sel = [];
let mode = null, swapSel = null, localMsg = "";
let lastSeq = -1, lastOver = false, showOver = false, anim = null, flip = null, busy = false;
let timeLeft = null, timeAt = 0;

function onView(v) {
  if (joinTimer && !isHost) { clearInterval(joinTimer); joinTimer = null; }
  if (!isHost) v.opponentConnected = peerOnline;
  const g = v.game;
  if (V && V.phase !== "play" && v.phase === "play") { lastSeq = -1; lastOver = false; showOver = false; }
  if (g) {
    if (g.seq !== lastSeq) {
      if (lastSeq !== -1 && g.ev) {
        const t = g.ev.type;
        if (t === "flip" || t === "pop") flip = { type: t, c: g.ev.c, prev: g.ev.prev, phase: 1 };
        else anim = { ...g.ev, type: t === "block" ? "drop" : t };
      }
      mode = null; swapSel = null; localMsg = "";
      if (g.over && !lastOver) {
        showOver = lastSeq === -1;
        if (!showOver) setTimeout(() => {
          showOver = true;
          const w = document.querySelector(".board-wrap");
          if (w && V && V.game && V.game.over && !w.querySelector(".over")) w.insertAdjacentHTML("beforeend", overHtml());
        }, (flip ? 600 : 0) + (g.result ? 2200 : 900));
      }
      if (!g.over) showOver = false;
      lastOver = g.over; lastSeq = g.seq;
    }
  } else { lastSeq = -1; lastOver = false; showOver = false; }
  if (v.myPicks) sel = v.myPicks.slice();
  else if (v.phase === "draft" && V && V.phase !== "draft") sel = [];
  timeLeft = v.timeLeftMs; timeAt = Date.now();
  V = v; if (err === "Connecting…" || /Waiting for the host/.test(err)) err = "";
  if (flip && flip.phase === 1) {
    busy = true; render();
    const f = flip;
    setTimeout(() => { if (flip === f) { flip.phase = 2; busy = false; render(); flip = null; } }, f.type === "pop" ? 420 : 560);
  } else render();
}

setInterval(() => {
  const t = document.getElementById("tnum");
  if (!t || timeLeft == null) return;
  const s = Math.min(TURN_S, Math.max(0, Math.ceil((timeLeft - (Date.now() - timeAt)) / 1000)));
  t.textContent = s + "s";
  document.getElementById("tfill").style.width = Math.min(100, s / TURN_S * 100) + "%";
  document.querySelector(".timer").classList.toggle("warn", s <= 5);
}, 250);

const header = extra => `<header class="top"><h1>Connect War</h1>${extra || ""}</header>`;
const you = p => V && p === V.seat ? "You" : "Opponent";

function render() {
  if (!sb) return renderSetupNeeded();
  if (!V) return renderHome();
  if (V.phase === "lobby") return renderLobby();
  if (V.phase === "draft") return renderDraft();
  renderPlay();
}

function renderSetupNeeded() {
  app.innerHTML = `${header()}
  <section class="setup">
    <h2>Connect your Supabase project</h2>
    <p class="muted">${window.supabase ? "Open <b>config.js</b> and paste your Supabase project URL and anon (publishable) key from Project Settings → API. Then reload this page." : "The Supabase library didn't load. Check your internet connection and reload."}</p>
  </section>`;
}

function renderHome() {
  const waiting = code && !isHost;
  app.innerHTML = `${header()}
  <section class="setup">
    <h2>Play online</h2>
    <p class="muted">Create a game and send the code or link to your opponent. Keep this page open while you host.</p>
    <label class="tog"><input type="checkbox" id="timerOn" ${timerOn ? "checked" : ""}> 20-second turn clock</label>
    <button class="primary" data-act="create">Create game</button>
    <div class="divider">OR</div>
    <form class="field" id="joinForm"><input id="code" maxlength="4" placeholder="CODE" autocomplete="off" aria-label="Game code" value="${waiting ? code : ""}"><button class="primary" type="submit">Join</button></form>
    <p class="err">${err}</p>
    ${waiting ? `<button class="ghost" data-act="leave">Cancel</button>` : ""}
  </section>`;
}

function renderLobby() {
  const url = location.origin + location.pathname + "#" + V.code;
  app.innerHTML = `${header()}
  <section class="setup">
    <div class="eyebrow">Game created</div>
    <h2>Send this to your opponent</h2>
    <div class="code">${V.code}</div>
    <div class="link" id="link">${url}</div>
    <button class="ghost" data-act="copy">Copy link</button>
    <p class="muted">Waiting for Player 2 to join… Keep this page open: your device runs the match.</p>
    <button class="ghost" data-act="leave">Cancel</button>
    <p class="err">${err}</p>
  </section>`;
}

function renderDraft() {
  const p = V.seat, locked = !!V.myPicks;
  const dc = !V.opponentConnected ? `<div class="banner">${isHost ? "Your opponent is disconnected." : "The host is disconnected. The game resumes when they reopen it."}</div>` : "";
  if (locked) {
    app.innerHTML = `${header()}
    <section class="setup" data-p="${p}">
      <div class="eyebrow c${p}">You are Player ${p}</div>
      <h2>Locked in</h2>
      <p class="muted">${V.myPicks.map(id => AB[id].name).join(" · ")}</p>
      <p class="muted">${V.oppLocked ? "Starting…" : "Waiting for your opponent to pick."}</p>
      ${dc}
    </section>`;
    return;
  }
  app.innerHTML = `${header()}
  <section class="setup" data-p="${p}">
    <div class="eyebrow c${p}">You are Player ${p}</div>
    <h2>Pick 3 abilities</h2>
    <p class="muted">Your opponent can't see your picks until both of you lock in. ${V.oppLocked ? "Your opponent has locked in." : ""}</p>
    ${dc}
    <div class="cards">${Object.entries(AB).map(([id, a]) => `<button class="card ${sel.includes(id) ? "on" : ""}" data-pick="${id}" aria-pressed="${sel.includes(id)}">
      <span class="cn">${a.name}</span><span class="cost">${a.cost} EN</span><span class="cd">${a.desc}</span></button>`).join("")}</div>
    <button class="primary" data-act="lock" ${sel.length === 3 ? "" : "disabled"}>Lock in (${sel.length}/3)</button>
    <p class="err">${err}</p>
  </section>`;
}

function panel(p) {
  const g = V.game, e = g.energy[p], fz = g.frozen && g.frozen.player === p;
  const picks = p === V.seat ? V.myPicks : V.oppPicks;
  const on = g.cur === p && !g.over;
  return `<div class="pl ${on ? "on" : ""}" data-p="${p}">
    <div class="nm"><b>${you(p)}</b>${on ? '<span class="turn">Turn</span>' : ""}</div>
    <div class="pips" aria-label="${e} of ${MAXE} energy">${Array.from({ length: MAXE }, (_, i) => `<i class="${i < e ? "f" : ""}"></i>`).join("")}<span>${e}/${MAXE}</span></div>
    <div class="lo">${(picks || []).map(id => AB[id].name).join(" · ")}${fz ? `<br>Column ${L[g.frozen.col]} frozen` : ""}</div>
  </div>`;
}

const PROMPT = {
  block: () => "Block: tap a column to drop a neutral stone.",
  freeze: () => "Freeze: tap a column to lock it for your opponent's next turn.",
  anchor: () => "Anchor: tap one of your discs.",
  lift: () => "Lift: tap a column whose top disc is yours.",
  pop: () => "Pop: tap a column whose bottom disc is your opponent's.",
  swap: () => "Swap: tap a disc, then an adjacent disc of the other color.",
  flip: () => "Flip: tap a column with 2 or more discs."
};

function statusText() {
  const g = V.game;
  if (localMsg) return localMsg;
  if (g.over) return g.result ? (g.result === V.seat ? "You connect four." : "Your opponent connects four.") : "Board full. Draw.";
  if (mode) return PROMPT[mode]();
  const note = g.note ? g.note.replace(new RegExp(`Player ${V.seat}`, "g"), "You").replace(new RegExp(`Player ${opp(V.seat)}`, "g"), "Opponent") + " " : "";
  if (g.cur === V.seat) {
    if (g.dd && g.dropsMade === 1) return note + "Place your second disc in a different column. It can't complete a 4.";
    if (g.abilityUsed && g.dropsMade === 0 && !g.dd) return note + "<b>Your turn</b>: now drop a disc.";
    return note + "<b>Your turn</b>: drop a disc, or use an ability first.";
  }
  return note + "Opponent's turn.";
}

function overHtml() {
  const g = V.game, other = opp(V.seat);
  const r = V.votes.rematch, d = V.votes.redraft;
  const title = g.result ? (g.result === V.seat ? "You win" : "You lose") : "Draw";
  const sub = r.includes(other) ? "Your opponent wants a rematch." : d.includes(other) ? "Your opponent wants new loadouts." : "";
  return `<div class="over"><div class="box">
    <div class="eyebrow ${g.result ? "c" + g.result : ""}">Match over</div>
    <h2>${title}</h2>
    ${sub ? `<p class="muted">${sub}</p>` : ""}
    <button class="primary" data-act="rematch" ${r.includes(V.seat) ? "disabled" : ""}>${r.includes(V.seat) ? "Waiting for opponent" : "Rematch"}</button>
    <button class="ghost" data-act="redraft" ${d.includes(V.seat) ? "disabled" : ""}>${d.includes(V.seat) ? "Waiting for opponent" : "New loadouts"}</button>
    <button class="ghost" data-act="leave">Leave game</button></div></div>`;
}

function renderPlay() {
  const g = V.game, myTurn = g.cur === V.seat && !g.over && !busy;
  const shown = flip && flip.phase === 1 ? { ...g, grid: flip.prev.grid, anc: flip.prev.anc } : g;
  const mt = mode ? AB[mode].t : null;
  const wins = new Map(g.over && !(flip && flip.phase === 1) ? g.win.map((k, i) => [k, i]) : []);
  let cols = "";
  for (let c = 0; c < COLS; c++) {
    let cls = "col";
    if (flip && flip.phase === 1 && flip.type === "flip" && flip.c === c) cls += " flip1";
    if (anim && anim.type === "freeze" && anim.c === c) cls += " frz-in";
    if (myTurn) {
      if (mt === "col" && CW.validCol(g, mode, c)) cls += " tgt";
      else if (!mode && CW.canDrop(g, c)) cls += " can";
    }
    if (g.frozen && !g.over && g.frozen.col === c) cls += " frz";
    let cells = "";
    for (let r = 0; r < ROWS; r++) {
      const v = shown.grid[r][c]; let cc = "cell";
      if (myTurn && (mt === "own" || mt === "pair") && CW.validCell(g, mode, r, c, swapSel)) cc += " tgt";
      if (swapSel && swapSel[0] === r && swapSel[1] === c) cc += " sel";
      const wi = wins.get(r + "," + c);
      if (wi !== undefined) cc += " win";
      let disc = "";
      const at = (rr, cc2) => rr === r && cc2 === c;
      if (v) {
        let n = 0, extra = "", style = "";
        if (anim && anim.type === "drop" && at(anim.r, anim.c)) n = r + 1;
        if (flip && flip.phase === 2 && flip.c === c) n = flip.type === "pop" ? 1 : ROWS - CW.count(g, c);
        if (n) { extra += " fall"; style = `--from:calc(${-n} * (116.3% + 3px));`; }
        if (flip && flip.phase === 1 && flip.type === "pop" && flip.c === c && r === ROWS - 1) extra += " burst";
        if (anim && anim.type === "anchor" && at(anim.r, anim.c)) extra += " anc-in";
        if (anim && anim.type === "swap") {
          const from = at(anim.r, anim.c) ? [anim.r2, anim.c2] : at(anim.r2, anim.c2) ? [anim.r, anim.c] : null;
          if (from) { extra += " slide"; style += `--sx:calc(${from[1] - c} * (116.3% + 7px));--sy:calc(${from[0] - r} * (116.3% + 3px));`; }
        }
        const lst = g.last && g.last.r === r && g.last.c === c && !g.over;
        disc = `<div class="disc d${v} ${shown.anc[r][c] ? "anc" : ""}${extra} ${lst ? "last" : ""}" ${style ? `style="${style}"` : ""}></div>`;
      } else if (anim && anim.type === "lift" && at(anim.r, anim.c)) {
        disc = `<div class="disc d${anim.v} lift-out"></div>`;
      }
      const wd = wi !== undefined ? `style="--wd:${(0.3 + wi * 0.15).toFixed(2)}s"` : "";
      cells += `<div class="${cc}" data-r="${r}" data-c="${c}" ${wd}>${disc}</div>`;
    }
    cols += `<div class="${cls}" role="button" aria-label="Column ${L[c]}">${cells}</div>`;
  }
  const ddFlash = anim && anim.type === "double";
  anim = null;
  const mine = V.myPicks || [];
  const tray = g.over ? "" : `<div class="tray">${mine.map(id => {
    const a = AB[id], ready = myTurn && CW.abilityReady(g, id, mine);
    return `<button class="ab ${mode === id ? "armed" : ""}" data-ab="${id}" ${ready || mode === id ? "" : "disabled"} title="${a.desc}">
      <span class="an">${a.name}</span><span class="ac">${a.cost} EN${mode === id ? " · tap to cancel" : ""}</span><span class="ad">${a.desc}</span></button>`;
  }).join("")}</div>`;
  const tl = timeLeft == null ? null : Math.min(TURN_S, Math.max(0, Math.ceil((timeLeft - (Date.now() - timeAt)) / 1000)));
  const timer = V.timerOn
    ? `<div class="timer ${tl != null && tl <= 5 ? "warn" : ""}"><div class="tbar"><i id="tfill" style="width:${tl == null ? 0 : tl / TURN_S * 100}%"></i></div><span id="tnum">${tl == null ? "–" : tl + "s"}</span></div>`
    : `<div class="timer off"><span>No clock</span></div>`;
  const dc = !V.opponentConnected
    ? `<div class="banner">${isHost ? `Your opponent is disconnected. They can rejoin with code ${V.code}.` : "The host is disconnected. The game resumes when they reopen it."}</div>` : "";
  app.innerHTML = `${header(timer)}
  ${dc}
  <div class="players">${panel(V.seat)}${panel(opp(V.seat))}</div>
  <p class="status" aria-live="polite">${statusText()}</p>
  <div class="board-wrap"><div class="board ${g.over && g.result && !(flip && flip.phase === 1) ? "won" : ""} ${ddFlash ? "dd-flash" : ""}">${cols}</div>${g.over && showOver ? overHtml() : ""}</div>
  <div class="letters">${[...L].map(x => `<span>${x}</span>`).join("")}</div>
  ${tray}
  <p class="err">${err}</p>
  <details><summary>Rules</summary><ul>
    <li>Connect 4 in a row on an 8×7 board.</li>
    <li>Each turn: gain 1 energy (max 7), optionally use one ability, then drop one disc.</li>
    <li>Gold ring = anchored disc (immune to Pop and Swap). Striped column = frozen for one player.</li>
    <li>If an ability makes four for both players, the player who used it wins.</li>
    <li>Turn clock timeout: no drop and no energy that turn.</li>
    <li>Rematch swaps who goes first.</li></ul></details>`;
}

/* ================= input ================= */
function sendAct(type, p) {
  act(type, p, res => { if (res && res.error) { localMsg = res.error; mode = null; swapSel = null; render(); } });
}

app.addEventListener("submit", e => {
  if (e.target.id !== "joinForm") return;
  e.preventDefault();
  const c = document.getElementById("code").value.trim().toUpperCase();
  if (c.length !== 4) { err = "Enter the 4-character game code."; return render(); }
  joinGame(c);
});
app.addEventListener("change", e => { if (e.target.id === "timerOn") timerOn = e.target.checked; });

app.addEventListener("click", e => {
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    const id = pick.dataset.pick, i = sel.indexOf(id);
    if (i >= 0) sel.splice(i, 1); else if (sel.length < 3) sel.push(id);
    return render();
  }
  const actEl = e.target.closest("[data-act]");
  if (actEl) {
    const a = actEl.dataset.act;
    if (a === "create") { err = ""; return createGame(); }
    if (a === "copy") {
      const txt = document.getElementById("link").textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => { actEl.textContent = "Copied"; }).catch(() => {});
      return;
    }
    if (a === "lock") return sendAct("pick", { ids: sel });
    if (a === "rematch" || a === "redraft") return sendAct("vote", { kind: a });
    if (a === "leave") { err = ""; return leave(); }
    return;
  }
  if (!V || V.phase !== "play" || !V.game || V.game.over || busy) return;
  const g = V.game;
  if (g.cur !== V.seat) return;
  localMsg = "";
  const ab = e.target.closest("[data-ab]");
  if (ab) {
    const id = ab.dataset.ab;
    if (mode === id) { mode = null; swapSel = null; return render(); }
    if (!CW.abilityReady(g, id, V.myPicks)) return;
    if (!CW.hasTarget(g, id)) { localMsg = `${AB[id].name} has no valid target right now.`; return render(); }
    if (AB[id].t === "none") return sendAct("ability", { id });
    mode = id; swapSel = null; return render();
  }
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  if (!mode) return sendAct("drop", { c });
  const t = AB[mode].t;
  if (t === "col") {
    if (!CW.validCol(g, mode, c)) { localMsg = "Not a valid column. " + PROMPT[mode](); return render(); }
    return sendAct("ability", { id: mode, c });
  }
  if (mode === "anchor") {
    if (!CW.validCell(g, "anchor", r, c)) { localMsg = "Tap one of your own unanchored discs."; return render(); }
    return sendAct("ability", { id: "anchor", r, c });
  }
  if (mode === "swap") {
    if (swapSel && swapSel[0] === r && swapSel[1] === c) { swapSel = null; return render(); }
    if (!swapSel) {
      if (!CW.validCell(g, "swap", r, c, null)) { localMsg = "That disc can't be swapped. " + PROMPT.swap(); return render(); }
      swapSel = [r, c]; localMsg = "Now tap an adjacent disc of the other color."; return render();
    }
    if (!CW.validCell(g, "swap", r, c, swapSel)) { localMsg = "Pick an adjacent, unanchored disc of the other color."; return render(); }
    return sendAct("ability", { id: "swap", r: swapSel[0], c: swapSel[1], r2: r, c2: c });
  }
});

/* ================= start ================= */
(function boot() {
  if (!sb) return render();
  const fromHash = location.hash.replace("#", "").trim().toUpperCase();
  const c = fromHash || store("cw_room");
  if (c && c.length === 4) joinGame(c); else render();
})();
