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
// Local play: both seats on this device, no network.
let isLocal = false, localSeat = 1, localHandoff = false, modeSeat = 1;
function localViewSeat() {
  if (room.phase === "play" && room.game && room.mode !== "rt") return room.game.over ? localSeat : room.game.cur;
  return room.phase === "play" && room.mode === "rt" ? 1 : localSeat;
}
function createLocal() {
  closeChannel();
  room = newRoom("LOCAL", timerOn, gameMode);
  room.guest = "local"; room.phase = "draft";
  isHost = true; isLocal = true; localSeat = 1; localHandoff = false; peerOnline = true; code = null;
  sel = []; V = null; lastSeq = -1;
  publish();
}

function newRoom(c, timerOn, mode) {
  return { code: c, mode: mode === "tactics" ? "tactics" : "rt", guest: null, phase: "lobby", picks: { 1: null, 2: null }, starter: 1, game: null,
    timerOn: !!timerOn, deadline: null, timerTurn: null, votes: { rematch: [], redraft: [] } };
}
function saveRoom() { if (room && !isLocal) store("cw_host_" + room.code, JSON.stringify(room)); }

function view(seat) {
  const other = opp(seat);
  const both = !!(room.picks[1] && room.picks[2]);
  return {
    code: room.code, local: isLocal, mode: room.mode || "tactics", hostNow: Date.now(), seat, phase: room.phase, timerOn: room.timerOn,
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
  if (isLocal) {
    if (room.phase === "play" && room.game && room.mode !== "rt" && !room.game.over) localSeat = room.game.cur;
    return onView(JSON.parse(JSON.stringify(view(localViewSeat()))));
  }
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
let rtTicker = null;
function ensureRtTicker() {
  if (rtTicker) return;
  rtTicker = setInterval(() => {
    if (!room || !room.game || room.game.over) return;
    if (room.mode === "rt") { if (RT.tick(room.game, Date.now())) publish(); }
    else if (CW.tickBombs(room.game, Date.now())) { if (room.game.over) { clearTimer(); room.deadline = null; } publish(); }
  }, 50);
}
function startMatch() {
  room.phase = "play";
  if (room.mode === "rt") {
    room.game = RT.newGame(Date.now());
    room.votes = { rematch: [], redraft: [] };
    clearTimer(); room.deadline = null; ensureRtTicker();
    return;
  }
  room.game = CW.newGame(room.starter);
  ensureRtTicker();
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
    if (room.mode === "rt") {
      const a = { id: p.id, c: Number(p.c), r: Number(p.r), r2: Number(p.r2), c2: Number(p.c2) };
      return type === "drop" ? RT.drop(g, seat, Number(p.c), Date.now()) : RT.ability(g, seat, a, room.picks[seat], Date.now());
    }
    if (seat !== g.cur) return "It's not your turn.";
    let e;
    if (type === "drop") e = CW.drop(g, Number(p.c));
    else e = CW.ability(g, { id: p.id, c: Number(p.c), r: Number(p.r), r2: Number(p.r2), c2: Number(p.c2) }, room.picks[seat]);
    if (e) return e;
    if (g.over) { clearTimer(); room.deadline = null; } else armTimer(type === "ability" && (p.id === "flip" || p.id === "pop" || p.id === "gravity") ? 800 : 0);
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
    let seat = 1;
    if (isLocal) {
      if (type === "vote") { handle(1, type, p); handle(2, type, p); if (room.phase === "draft") { localSeat = 1; localHandoff = false; sel = []; } cb && cb({ ok: true }); return publish(); }
      seat = (p && p.__seat) || (room.phase === "play" && room.mode !== "rt" && room.game ? room.game.cur : localSeat);
    }
    const e = handle(seat, type, p);
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
  room = newRoom(c, timerOn, gameMode);
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
  ensureRtTicker();
  if (room.mode === "rt") {}
  else if (room.game && !room.game.over) { room.timerTurn = null; if (room.deadline) { const left = room.deadline - Date.now(); room.deadline = Date.now() + Math.max(1000, left); room.timerTurn = room.game.turnId; } armTimer(); }
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
  closeChannel(); isLocal = false; localHandoff = false;
  if (isHost && room) store("cw_host_" + room.code, null);
  clearTimer(); room = null; isHost = false; code = null; V = null;
  store("cw_room", null); store("cw_role", null);
  history.replaceState(null, "", location.pathname);
  sel = []; mode = null; lastSeq = -1;
}
function leave() {
  if (isHost && !isLocal) send("closed", {});
  setTimeout(() => { leaveLocal(); render(); }, isHost && !isLocal ? 150 : 0);
}

/* ================= view + rendering ================= */
let V = null, err = "", timerOn = true, sel = [];
let mode = null, swapSel = null, localMsg = "";
let lastSeq = -1, lastOver = false, showOver = false, flip = null, busy = false, confirmMenu = false;
// Short animations in flight. Re-renders resume them part-way (negative animation-delay) instead of restarting or dropping them.
let fx = [];
const FX_MS = { drop: 450, freeze: 650, anchor: 550, swap: 500, lift: 600, double: 750, score: 900, contest: 1100, reinforce: 450 };
// Full Auto drop-charge readout, e.g. "Drops ●●○ · 1.4s".
function dropText(g, seat, now) {
  const ch = RT.chargesAt(g, seat, now);
  const dots = "●".repeat(ch.n) + "○".repeat(RT.MAX_CHARGES - ch.n);
  return `Drops ${dots}${ch.n < RT.MAX_CHARGES ? " · " + ((ch.next - now) / 1000).toFixed(1) + "s" : ""}`;
}
const fxNow = () => performance.now();
function fxFind(type, pred) {
  const t = fxNow();
  fx = fx.filter(f => t - f.start < (FX_MS[f.type] || 600));
  const f = fx.find(f => f.type === type && (!pred || pred(f)));
  return f ? { ...f, ad: `--ad:${-Math.round(t - f.start)}ms;` } : null;
}
let timeLeft = null, timeAt = 0;
let gameMode = "tactics", skew = 0, readyKey = "";
const isRT = () => !!(V && V.mode === "rt");
const hostNow = () => Date.now() + skew;
const fmtClock = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };

function onView(v) {
  if (joinTimer && !isHost) { clearInterval(joinTimer); joinTimer = null; }
  if (!isHost) v.opponentConnected = peerOnline;
  const g = v.game;
  if (V && V.phase !== "play" && v.phase === "play") { lastSeq = -1; lastOver = false; showOver = false; }
  if (g) {
    if (g.seq !== lastSeq) {
      flip = null; busy = false;
      if (lastSeq !== -1 && g.ev) {
        const t = g.ev.type;
        if (t === "flip" || t === "pop" || t === "gravity") flip = { type: t, c: g.ev.c, prev: g.ev.prev, phase: 1 };
        else if (g.ev.clears && g.ev.prev) flip = { type: "clear", prev: g.ev.prev, clears: g.ev.clears, phase: 1, ev: g.ev };
        else fx.push({ ...g.ev, type: t === "block" ? "drop" : t, start: fxNow() });
      }
      if (v.mode === "rt" && !g.over) {
        localMsg = "";
        if (swapSel && !CW.validCell({ ...g, cur: v.local ? modeSeat : v.seat }, "swap", swapSel[0], swapSel[1], null)) swapSel = null;
      } else { mode = null; swapSel = null; localMsg = ""; }
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
  if (v.hostNow) skew = isHost ? 0 : v.hostNow - Date.now();
  V = v; if (err === "Connecting…" || /Waiting for the host/.test(err)) err = "";
  if (flip && flip.phase === 1) {
    busy = flip.type !== "clear"; render();
    const f = flip;
    setTimeout(() => { if (flip === f) { flip.phase = 2; busy = false; render(); flip = null; } }, f.type === "pop" ? 420 : f.type === "clear" ? (f.ev && f.ev.type === "boom" ? 520 : 820) : f.type === "gravity" ? 340 : 560);
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

// Real-time mode: refresh the match clock and cooldown meters without redrawing the board.
setInterval(() => {
  if (!isRT() || V.phase !== "play" || !V.game) return;
  const g = V.game, now = hostNow(), mine = g.ready[V.seat] || {};
  const rdy = seat => g.ready[seat] || {};
  const ck = document.getElementById("mclock");
  if (ck) ck.textContent = g.sudden ? "SUDDEN DEATH" : fmtClock(g.endsAt - now);
  if (ck) ck.parentElement.classList.toggle("warn", !g.sudden && g.endsAt - now < 30000);
  document.querySelectorAll("[data-cd]").forEach(el => {
    const k = el.dataset.cd, seat = el.dataset.seat || V.seat;
    if (k === "drop") {
      const ch = RT.chargesAt(g, seat, now);
      el.style.setProperty("--p", ch.n < RT.MAX_CHARGES ? Math.min(1, (ch.next - now) / ch.step) : 0);
      el.classList.toggle("empty", ch.n === 0);
      const t = el.querySelector(".cdt"); if (t) t.textContent = dropText(g, seat, now);
      return;
    }
    const total = RT.CD[k] * (g.sudden ? 0.25 : 1);
    const rem = Math.max(0, (rdy(el.dataset.seat || V.seat)[k] || 0) - now);
    el.style.setProperty("--p", Math.min(1, rem / total));
    const t = el.querySelector(".cdt"); if (t) t.textContent = rem ? (rem / 1000).toFixed(1) + "s" : "Ready";
  });
  const seats = V.local ? [1, 2] : [V.seat];
  const key = seats.map(st => ["gcd", ...((st === V.seat ? V.myPicks : V.oppPicks) || [])].map(k => (rdy(st)[k] || 0) <= now ? 1 : 0).join("") + RT.chargesAt(g, st, now).n).join("|") + g.frozen.filter(f => f.until > now).length + (g.pending && g.pending.until > now ? "p" : "");
  if (key !== readyKey) { readyKey = key; if (!busy) render(); }
}, 100);

const header = extra => `<header class="top"><h1>Connect War</h1><div class="hdr-right">${extra || ""}${V || code || isLocal ? `<button class="exit" data-act="menu">Main menu</button>` : ""}</div></header>`;
const menuModal = () => `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mm-t"><div class="box">
  <h2 id="mm-t">Leave this game?</h2>
  <p class="muted">${V && V.phase === "play" && V.game && !V.game.over ? (isLocal ? "The match will end." : isHost ? "You're the host, so the match ends for both players." : "You'll leave the match. You can rejoin with the code.") : "You'll go back to the main menu."}</p>
  <button class="primary" data-act="menu-yes">Leave to main menu</button>
  <button class="ghost" data-act="menu-no">Stay</button></div></div>`;
const you = p => (V && V.local ? `Player ${p}` : V && p === V.seat ? "You" : "Opponent");
const localName = text => text; // local mode keeps "Player 1/2" wording

function render() {
  renderScreen();
  if (confirmMenu) app.insertAdjacentHTML("beforeend", menuModal());
}
function renderScreen() {
  if (localHandoff) return renderHandoff();
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

function renderHandoff() {
  app.innerHTML = `${header()}
  <section class="handoff">
    <div class="eyebrow c1">Player 1 locked in</div>
    <h2>Pass the phone to Player 2</h2>
    <p class="muted">Player 1, look away while Player 2 picks.</p>
    <button class="primary" data-act="p2ready">I'm Player 2</button>
  </section>`;
}

function renderHome() {
  const waiting = code && !isHost;
  app.innerHTML = `${header()}
  <section class="setup">
    <h2>New game</h2>
    <div class="modes">
      <button class="mode ${gameMode === "tactics" ? "on" : ""}" data-mode="tactics" aria-pressed="${gameMode === "tactics"}"><span class="cn">Connect War</span><span class="cd">Turn based with energy. One four wins.</span></button>
      <button class="mode ${gameMode === "rt" ? "on" : ""}" data-mode="rt" aria-pressed="${gameMode === "rt"}"><span class="cn">Connect War: Full Auto</span><span class="cd">Real time. No turns: drop charges and ability cooldowns. Scored fours turn to stone. First to 5 in 5 minutes.</span></button>
    </div>
    ${gameMode === "tactics" ? `<label class="tog"><input type="checkbox" id="timerOn" ${timerOn ? "checked" : ""}> 20-second turn clock</label>` : ""}
    <div class="row2">
      <button class="primary" data-act="create" ${sb ? "" : "disabled"}>Play online</button>
      <button class="ghost strong" data-act="local">Play local</button>
    </div>
    <p class="muted small">Online: send your opponent a code. Local: two players on this phone${gameMode === "rt" ? ", one at each end" : ", passing it between turns"}.</p>
    ${sb ? "" : `<p class="err">Online play is unavailable: the game server didn't load. Local play still works.</p>`}
    <div class="divider">JOIN A GAME</div>
    <form class="field" id="joinForm" ${sb ? "" : "hidden"}><input id="code" maxlength="4" placeholder="CODE" autocomplete="off" aria-label="Game code" value="${waiting ? code : ""}"><button class="primary" type="submit">Join</button></form>
    <p class="err">${err}</p>
    ${waiting ? `<button class="ghost" data-act="leave">Cancel</button>` : ""}
    ${!waiting && store("cw_room") && store("cw_room") !== "LOCAL" ? `<button class="ghost" data-act="rejoin">Rejoin game ${store("cw_room")}</button>` : ""}
    <button class="linkbtn" data-act="reset">Stuck? Reset saved games</button>
  </section>`;
}

function renderLobby() {
  const url = location.origin + location.pathname + "#" + V.code;
  app.innerHTML = `${header()}
  <section class="setup">
    <div class="eyebrow">${modeName()} · Game created</div>
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
    <div class="eyebrow c${p}">${modeName()} · ${V.local ? "Local · " : ""}${V.local ? "" : "You are "}Player ${p}</div>
    <h2>${V.local ? `Player ${p}: pick 3 abilities` : "Pick 3 abilities"}</h2>
    <p class="muted">${V.local ? (p === 1 ? "Player 2, look away. Picks stay hidden until the match starts." : "Player 1, look away.") : `Your opponent can't see your picks until both of you lock in. ${V.oppLocked ? "Your opponent has locked in." : ""}`}</p>
    ${dc}
    <div class="cards">${Object.entries(AB).map(([id, a]) => `<button class="card ${sel.includes(id) ? "on" : ""}" data-pick="${id}" aria-pressed="${sel.includes(id)}">
      <span class="cn">${a.name}</span><span class="cost">${costLabel(id)}</span><span class="cd">${descOf(id)}</span></button>`).join("")}</div>
    <button class="primary" data-act="lock" ${sel.length === 3 ? "" : "disabled"}>Lock in (${sel.length}/3)</button>
    <p class="err">${err}</p>
  </section>`;
}

const modeName = () => (V && V.mode === "rt" ? "Connect War: Full Auto" : "Connect War");
const costLabel = id => (isRT() ? RT.CD[id] / 1000 + "s" : AB[id].cost + " EN");
const descOf = id => (isRT() ? RT.DESC[id] : AB[id].desc);
const frozenCols = (g, p) => (isRT() ? g.frozen.filter(f => f.player === p && f.until > hostNow()) : g.frozen && g.frozen.player === p ? [g.frozen] : []);

function panelRT(p) {
  const g = V.game, s = g.score[p], fz = frozenCols(g, p);
  const picks = p === V.seat ? V.myPicks : V.oppPicks;
  return `<div class="pl" data-p="${p}">
    <div class="nm"><b>${you(p)}</b><span class="score">${s}</span></div>
    <div class="pips" aria-label="${s} of ${RT.TARGET} points">${Array.from({ length: RT.TARGET }, (_, i) => `<i class="pt ${i < s ? "f" : ""}"></i>`).join("")}<span>${s}/${RT.TARGET}</span></div>
    <div class="lo">${(picks || []).map(id => AB[id].name).join(" · ")}${fz.length ? `<br>Column ${fz.map(f => L[f.col]).join(", ")} frozen` : ""}</div>
  </div>`;
}

function panel(p) {
  if (isRT()) return panelRT(p);
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
  pop: () => `Pop: tap a column whose ${V && V.game && V.game.gdir === -1 ? "top" : "bottom"} disc is your opponent's.`,
  swap: () => "Swap: tap a disc, then an adjacent disc of the other color.",
  flip: () => "Flip: tap a column with 2 or more discs.",
  reinforce: () => `Reinforce: tap a column to slide your disc in from the ${V && V.game && V.game.gdir === -1 ? "top" : "bottom"}.`,
  grenade: () => "Grenade: tap a column to drop it. It explodes 2 seconds later."
};

function statusText() {
  const g = V.game;
  if (localMsg) return localMsg;
  if (isRT()) {
    if (g.over && V.local) return `Player ${g.result} wins ${g.score[g.result]}–${g.score[opp(g.result)]}.`;
    if (g.over) return g.result === V.seat ? `You win ${g.score[V.seat]}–${g.score[opp(V.seat)]}.` : `You lose ${g.score[V.seat]}–${g.score[opp(V.seat)]}.`;
    if (mode) return (mode === "freeze" ? "Freeze: tap a column to lock it for your opponent for 5 seconds." : PROMPT[mode]());
    const nt = V.local ? g.note : g.note ? g.note.replace(new RegExp(`Player ${V.seat}`, "g"), "You").replace(new RegExp(`Player ${opp(V.seat)}`, "g"), "Opponent") : "";
    return (g.sudden ? "<b>Sudden death</b>: next score wins. " : "") + (nt || "Go! Drop discs as fast as your cooldowns allow.");
  }
  if (g.over && V.local) return g.result ? `Player ${g.result} connects four.` : "Board full. Draw.";
  if (g.over) return g.result ? (g.result === V.seat ? "You connect four." : "Your opponent connects four.") : "Board full. Draw.";
  if (mode) return PROMPT[mode]();
  if (V.local) {
    const who = `<b class="c${g.cur}">Player ${g.cur}</b>`;
    const nl = g.note ? g.note + " " : "";
    if (g.dd && g.dropsMade === 1) return nl + who + ": place your second disc in a different column. It can't complete a 4.";
    if (g.abilityUsed && g.dropsMade === 0 && !g.dd) return nl + who + ": now drop a disc.";
    return nl + who + ": drop a disc, or use an ability first.";
  }
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
  const title = g.result ? (V.local ? `Player ${g.result} wins` : g.result === V.seat ? "You win" : "You lose") : "Draw";
  const sub = r.includes(other) ? "Your opponent wants a rematch." : d.includes(other) ? "Your opponent wants new loadouts." : "";
  return `<div class="over"><div class="box">
    <div class="eyebrow ${g.result ? "c" + g.result : ""}">Match over</div>
    <h2>${title}</h2>
    ${isRT() ? `<p class="muted">${V.local ? `Player 1 ${g.score[1]} – ${g.score[2]} Player 2` : `${g.score[V.seat]}–${g.score[other]}`}${g.sudden ? " in sudden death" : ""}</p>` : ""}
    ${sub ? `<p class="muted">${sub}</p>` : ""}
    <button class="primary" data-act="rematch" ${r.includes(V.seat) && !V.local ? "disabled" : ""}>${r.includes(V.seat) ? "Waiting for opponent" : "Rematch"}</button>
    <button class="ghost" data-act="redraft" ${d.includes(V.seat) && !V.local ? "disabled" : ""}>${d.includes(V.seat) ? "Waiting for opponent" : "New loadouts"}</button>
    <button class="ghost" data-act="leave">Leave game</button></div></div>`;
}

// After fours are removed, discs that were above them fall by the number removed in that column.
const gravCls = () => (flip && flip.phase === 1 && flip.type === "gravity" ? "grav1" : "");
function clearedFall(f, r, c, gup) {
  let n = 0, maxRow = -1, minRow = ROWS;
  for (const grp of f.clears) for (const k of grp.cells) { const [rr, cc] = k.split(",").map(Number); if (cc === c) { n++; maxRow = Math.max(maxRow, rr); minRow = Math.min(minRow, rr); } }
  if (!n) return 0;
  return gup ? (r >= minRow - n ? n : 0) : (r <= maxRow ? n : 0);
}

function renderPlay() {
  const rt = isRT(), now = hostNow();
  const g0 = V.game, g = rt ? { ...g0, cur: V.local ? modeSeat : V.seat } : g0;
  const myTurn = rt ? !g.over && !busy : g.cur === V.seat && !g.over && !busy;
  const canDropCol = c => (rt ? RT.canDrop(g, V.seat, c, now) : CW.canDrop(g, c));
  const shown = flip && flip.phase === 1 ? { ...g, grid: flip.prev.grid, anc: flip.prev.anc } : g;
  const cleared = new Map();
  if (flip && flip.type === "clear") {
    flip.clears.forEach(f => f.cells.forEach((k, i) => cleared.set(k, i)));
  }
  const pend = rt && g.pending ? new Set(g.pending.cells) : null;
  const mt = mode ? AB[mode].t : null;
  const wins = new Map(g.over && !(flip && flip.phase === 1) ? g.win.map((k, i) => [k, i]) : []);
  let cols = "";
  const gup = g.gdir === -1;
  // Disc motion toward the current floor: falls when gravity is down, rises when it is up.
  const motion = n => (gup ? [" rise", `--from:calc(${n} * (116.3% + 3px));`] : [" fall", `--from:calc(${-n} * (116.3% + 3px));`]);
  for (let c = 0; c < COLS; c++) {
    let cls = "col", colStyle = "";
    if (flip && flip.phase === 1 && flip.type === "flip" && flip.c === c) cls += " flip1";
    const fz = fxFind("freeze", f => f.c === c);
    if (fz) { cls += " frz-in"; colStyle = fz.ad; }
    if (myTurn) {
      if (mt === "col" && CW.validCol(g, mode, c)) cls += " tgt";
      else if (!mode && !(rt && V.local) && canDropCol(c)) cls += " can";
    }
    if (!g.over && (rt ? g.frozen.some(f => f.col === c && f.until > now) : g.frozen && g.frozen.col === c)) cls += " frz";
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
        const dfx = fxFind("drop", f => at(f.r, f.c));
        if (dfx) { n = gup ? ROWS - r : r + 1; style += dfx.ad; }
        if (flip && flip.phase === 2 && (flip.type === "gravity" || (flip.type !== "clear" && flip.c === c))) n = flip.type === "pop" ? 1 : ROWS - CW.count(g, c);
        if (flip && flip.phase === 2 && flip.type === "clear") n = clearedFall(flip, r, c, gup);
        if (flip && flip.phase === 1 && flip.type === "clear" && flip.ev && flip.ev.type === "drop" && at(flip.ev.r, flip.ev.c)) n = gup ? ROWS - r : r + 1;
        if (flip && flip.phase === 1 && flip.type === "clear" && cleared.has(r + "," + c)) { extra += flip.ev && flip.ev.type === "boom" ? " boomed" : " scored"; style += `--wd:${(0.25 + cleared.get(r + "," + c) * 0.06).toFixed(2)}s;`; }
        if (v === 5) n = 0; // fixed stones never move
        if (n) { const [k, st] = motion(n); extra += k; style += st; }
        const popFloor = (flip && flip.prev && flip.prev.gdir === -1) || (!flip && gup) ? 0 : ROWS - 1;
        if (flip && flip.phase === 1 && flip.type === "pop" && flip.c === c && r === popFloor) extra += " burst";
        const key = r + "," + c;
        const pfx = fxFind("score", f => (f.petrify || []).includes(key)) || fxFind("contest", f => (f.petrify || []).includes(key));
        if (pfx) { extra += " petrify"; style += pfx.ad; }
        const rfx = fxFind("reinforce", f => f.c === c && (f.gdir === -1 ? r < f.n : r >= ROWS - f.n));
        if (rfx) { extra += " push"; style += rfx.ad + `--push:calc(${rfx.gdir === -1 ? -1 : 1} * (116.3% + 3px));`; }
        const afx = fxFind("anchor", f => at(f.r, f.c));
        if (afx) { extra += " anc-in"; style += afx.ad; }
        const sfx = fxFind("swap", f => at(f.r, f.c) || at(f.r2, f.c2));
        if (sfx) {
          const from = at(sfx.r, sfx.c) ? [sfx.r2, sfx.c2] : [sfx.r, sfx.c];
          extra += " slide"; style += sfx.ad + `--sx:calc(${from[1] - c} * (116.3% + 7px));--sy:calc(${from[0] - r} * (116.3% + 3px));`;
        }
        if (pend && pend.has(r + "," + c) && !(flip && flip.phase === 1)) extra += " pend";
        const lst = g.last && g.last.r === r && g.last.c === c && !g.over;
        if (v === 4) { const b = (g0.bombs || []).find(x => x.id === shown.anc[r][c]); if (b && b.until - now < 900) extra += " fuse-hot"; }
        disc = `<div class="disc d${v} ${shown.anc[r][c] && v !== 4 ? "anc" : ""}${extra} ${lst ? "last" : ""}" ${style ? `style="${style}"` : ""}></div>`;
      } else {
        const lfx = fxFind("lift", f => at(f.r, f.c));
        if (lfx) disc = `<div class="disc d${lfx.v} lift-out${gup ? " down" : ""}" style="${lfx.ad}"></div>`;
      }
      if (flip && flip.phase === 1 && flip.ev && flip.ev.type === "boom" && at(flip.ev.r, flip.ev.c)) disc += `<div class="blast"></div>`;
      const wd = wi !== undefined ? `style="--wd:${(0.3 + wi * 0.15).toFixed(2)}s"` : "";
      cells += `<div class="${cc}" data-r="${r}" data-c="${c}" ${wd}>${disc}</div>`;
    }
    cols += `<div class="${cls}" ${colStyle ? `style="${colStyle}"` : ""} role="button" aria-label="Column ${L[c]}">${cells}</div>`;
  }
  const dd = fxFind("double");
  const ddFlash = dd ? `dd-flash" style="${dd.ad}` : "";
  const mine = V.myPicks || [];
  const trayRT = () => `<div class="dropbar" data-cd="drop"><i></i><span class="cdt">${dropText(g, V.seat, now)}</span></div>
  <div class="tray">${mine.map(id => {
    const a = AB[id], ready = myTurn && RT.isReady(g, V.seat, id, now);
    return `<button class="ab cdbtn ${mode === id ? "armed" : ""}" data-ab="${id}" data-cd="${id}" ${ready || mode === id ? "" : "disabled"}>
      <i class="cdfill"></i><span class="an">${a.name}</span><span class="ac">${RT.CD[id] / 1000}s · <span class="cdt"></span>${mode === id ? " · tap to cancel" : ""}</span><span class="ad">${RT.DESC[id]}</span></button>`;
  }).join("")}</div>`;
  const tray = g.over ? "" : rt ? trayRT() : `<div class="tray">${mine.map(id => {
    const a = AB[id], ready = myTurn && CW.abilityReady(g, id, mine);
    return `<button class="ab ${mode === id ? "armed" : ""}" data-ab="${id}" ${ready || mode === id ? "" : "disabled"} title="${a.desc}">
      <span class="an">${a.name}</span><span class="ac">${a.cost} EN${mode === id ? " · tap to cancel" : ""}</span><span class="ad">${a.desc}</span></button>`;
  }).join("")}</div>`;
  const tl = timeLeft == null ? null : Math.min(TURN_S, Math.max(0, Math.ceil((timeLeft - (Date.now() - timeAt)) / 1000)));
  const timer = rt
    ? `<div class="timer mclock ${g.sudden ? "warn" : ""}"><span id="mclock">${g.sudden ? "SUDDEN DEATH" : fmtClock(g.endsAt - now)}</span></div>`
    : V.timerOn
    ? `<div class="timer ${tl != null && tl <= 5 ? "warn" : ""}"><div class="tbar"><i id="tfill" style="width:${tl == null ? 0 : tl / TURN_S * 100}%"></i></div><span id="tnum">${tl == null ? "–" : tl + "s"}</span></div>`
    : `<div class="timer off"><span>No clock</span></div>`;
  if (rt && V.local) return renderTabletop({ g, g0, now, cols, pend, ddFlash });
  const dc = !V.opponentConnected
    ? `<div class="banner">${isHost ? `Your opponent is disconnected. They can rejoin with code ${V.code}.` : "The host is disconnected. The game resumes when they reopen it."}</div>` : "";
  app.innerHTML = `${header(timer)}
  ${dc}
  <div class="players">${panel(V.seat)}${panel(opp(V.seat))}</div>
  <p class="status" aria-live="polite">${statusText()}</p>
  <div class="board-wrap"><div class="board ${!rt && g.over && g.result && !(flip && flip.phase === 1) ? "won" : ""} ${gravCls()} ${g.gdir === -1 ? "up" : ""} ${ddFlash}">${cols}</div>${pend ? `<div class="contest">Contested!</div>` : ""}${fxFind("contest") ? `<div class="contest cancel">Contested! Cancelled</div>` : ""}${g.over && showOver ? overHtml() : ""}</div>
  <div class="letters">${[...L].map(x => `<span>${x}</span>`).join("")}</div>
  ${g.gdir === -1 ? `<div class="gravtag">Gravity is up: discs rise from the bottom</div>` : ""}
  ${tray}
  <p class="err">${err}</p>
  ${rt ? `<details><summary>Rules</summary><ul>
    <li>No turns. You hold up to 3 drop charges; one recharges every 2.5s. Each ability has its own cooldown. Any action also starts a 0.15s global cooldown.</li>
    <li>Each four scores 1 point, and its discs turn into fixed stones. Fixed stones never move (not even with Gravity Flip); a grenade can destroy them.</li>
    <li>Contested: after a four, your opponent has 0.5s to make their own four. If they do, neither scores and both fours turn to stone.</li>
    <li>First to 5 wins. After 5 minutes the higher score wins. A tie goes to sudden death: cooldowns ×¼, next score wins.</li>
    <li>A full board with no four is wiped.</li></ul></details>` : `<details><summary>Rules</summary><ul>
    <li>Connect 4 in a row on an 8×7 board.</li>
    <li>Each turn: gain 1 energy (max 7), optionally use one ability, then drop one disc.</li>
    <li>Gold ring = anchored disc (immune to Pop and Swap). Striped column = frozen for one player.</li>
    <li>If an ability makes four for both players, the player who used it wins.</li>
    <li>Turn clock timeout: no drop and no energy that turn.</li>
    <li>Rematch swaps who goes first.</li></ul></details>`}`;
}

// Real-time local: Player 2's controls at the top (turned to face them), Player 1's at the bottom.
function renderTabletop({ g, g0, now, cols, pend, ddFlash }) {
  const side = st => {
    const picks = (st === V.seat ? V.myPicks : V.oppPicks) || [];
    const s = g0.score[st], fz = frozenCols(g0, st);
    const order = st === 2 ? [...Array(COLS).keys()].reverse() : [...Array(COLS).keys()];
    return `<section class="side ${st === 2 ? "flipside" : ""}" data-p="${st}">
      <div class="sidehead"><b class="c${st}">Player ${st}</b>
        <span class="pips">${Array.from({ length: RT.TARGET }, (_, i) => `<i class="pt ${i < s ? "f" : ""}"></i>`).join("")}</span>
        <span class="score">${s}</span>${fz.length ? `<span class="fzn">${fz.map(f => L[f.col]).join(", ")} frozen</span>` : ""}</div>
      ${g0.over ? "" : `<div class="droprow">${order.map(c => `<button class="dropbtn b${st}" data-drop="${c}" data-seat="${st}" ${RT.canDrop(g0, st, c, now) ? "" : "disabled"} aria-label="Player ${st}: drop in column ${L[c]}">${L[c]}</button>`).join("")}</div>
      <div class="dropbar" data-cd="drop" data-seat="${st}"><i></i><span class="cdt">${dropText(g0, st, now)}</span></div>
      <div class="tray">${picks.map(id => {
        const a = AB[id], armed = mode === id && modeSeat === st, ready = !g0.over && !busy && RT.isReady(g0, st, id, now);
        return `<button class="ab cdbtn ${armed ? "armed" : ""}" data-ab="${id}" data-seat="${st}" data-cd="${id}" ${ready || armed ? "" : "disabled"}>
          <i class="cdfill"></i><span class="an">${a.name}</span><span class="ac">${RT.CD[id] / 1000}s · <span class="cdt"></span>${armed ? " · tap to cancel" : ""}</span><span class="ad">${RT.DESC[id]}</span></button>`;
      }).join("")}</div>`}
    </section>`;
  };
  const status = mode ? `<b class="c${modeSeat}">Player ${modeSeat}</b> · ${statusText()}` : statusText();
  app.innerHTML = `${header(`<div class="timer mclock ${g0.sudden ? "warn" : ""}"><span id="mclock">${g0.sudden ? "SUDDEN DEATH" : fmtClock(g0.endsAt - now)}</span></div>`)}
  ${side(2)}
  <p class="status tabletop-status" aria-live="polite">${status}${g0.gdir === -1 ? ` <span class="gravtag inline">Gravity up</span>` : ""}</p>
  <div class="board-wrap"><div class="board ${gravCls()} ${g0.gdir === -1 ? "up" : ""} ${ddFlash}">${cols}</div>${pend ? `<div class="contest">Contested!</div>` : ""}${fxFind("contest") ? `<div class="contest cancel">Contested! Cancelled</div>` : ""}${g0.over && showOver ? overHtml() : ""}</div>
  ${side(1)}
  ${g0.over ? `<button class="ghost" data-act="leave">Leave game</button>` : ""}`;
}

/* ================= input ================= */
function sendAct(type, p) {
  if (V && V.local && isRT() && type === "ability" && p.__seat == null) p.__seat = modeSeat;
  if (type === "ability") { mode = null; swapSel = null; }
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
  const modeBtn = e.target.closest("[data-mode]");
  if (modeBtn) { gameMode = modeBtn.dataset.mode; return render(); }
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
    if (a === "local") { err = ""; return createLocal(); }
    if (a === "menu") { confirmMenu = true; return app.insertAdjacentHTML("beforeend", menuModal()); }
    if (a === "menu-no") { confirmMenu = false; const m = app.querySelector(".modal"); if (m) m.remove(); return; }
    if (a === "menu-yes") { confirmMenu = false; err = ""; return leave(); }
    if (a === "rejoin") { err = ""; return joinGame(store("cw_room")); }
    if (a === "reset") { hardReset(); err = "Saved games cleared."; return render(); }
    if (a === "p2ready") { localHandoff = false; localSeat = 2; sel = []; return publish(); }
    if (a === "copy") {
      const txt = document.getElementById("link").textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => { actEl.textContent = "Copied"; }).catch(() => {});
      return;
    }
    if (a === "lock") {
      const first = isLocal && localSeat === 1;
      sendAct("pick", { ids: sel });
      if (first && room && room.phase === "draft") { localHandoff = true; render(); }
      return;
    }
    if (a === "rematch" || a === "redraft") return sendAct("vote", { kind: a });
    if (a === "leave") { err = ""; return leave(); }
    return;
  }
  if (!V || V.phase !== "play" || !V.game || V.game.over || busy) return;
  const rt = isRT(), tabletop = rt && V.local;
  const dropBtn = e.target.closest("[data-drop]");
  if (dropBtn) {
    const st = +dropBtn.dataset.seat, c = +dropBtn.dataset.drop;
    if (!RT.canDrop(V.game, st, c, hostNow())) return;
    return sendAct("drop", { c, __seat: st });
  }
  const abEl = e.target.closest("[data-ab]");
  if (tabletop && abEl) {
    const st = +abEl.dataset.seat, id = abEl.dataset.ab;
    if (mode === id && modeSeat === st) { mode = null; swapSel = null; return render(); }
    const gs = { ...V.game, cur: st };
    if (!RT.isReady(gs, st, id, hostNow())) return;
    if (!CW.hasTarget(gs, id)) { localMsg = `Player ${st}: ${AB[id].name} has no valid target right now.`; return render(); }
    if (AB[id].t === "none") return sendAct("ability", { id, __seat: st });
    mode = id; modeSeat = st; swapSel = null; localMsg = ""; return render();
  }
  if (tabletop && !mode) return;
  const actSeat = tabletop ? modeSeat : V.seat;
  const g = rt ? { ...V.game, cur: actSeat } : V.game;
  if (!rt && g.cur !== V.seat) return;
  localMsg = "";
  const ab = abEl;
  if (ab) {
    const id = ab.dataset.ab;
    if (mode === id) { mode = null; swapSel = null; return render(); }
    if (rt ? !RT.isReady(g, V.seat, id, hostNow()) : !CW.abilityReady(g, id, V.myPicks)) return;
    if (!CW.hasTarget(g, id)) { localMsg = `${AB[id].name} has no valid target right now.`; return render(); }
    if (AB[id].t === "none") return sendAct("ability", { id });
    mode = id; swapSel = null; return render();
  }
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  if (!mode) {
    if (rt && !RT.canDrop(g, V.seat, c, hostNow())) return;
    return sendAct("drop", { c });
  }
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
function hardReset() {
  try { Object.keys(localStorage).filter(k => k.startsWith("cw_") && k !== "cw_token").forEach(k => localStorage.removeItem(k)); } catch (e) {}
  leaveLocal();
}
(function boot() {
  const fromHash = location.hash.replace("#", "").trim().toUpperCase();
  if (fromHash === "RESET") { hardReset(); return render(); }
  if (!sb) return render();
  // Only a link with a code joins automatically. A remembered game shows a Rejoin button instead.
  if (fromHash.length === 4) joinGame(fromHash); else render();
})();
