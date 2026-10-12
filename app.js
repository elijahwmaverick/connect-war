// Connect War over Supabase Realtime.
// The host's browser owns the match (rules, clock, picks) and broadcasts the board.
// The guest sends taps to the host and draws whatever the host sends back.
const { MAXE, TURN_S, AB, opp } = CW;
// Board size follows the game being shown (3-player games use 10×8).
let ROWS = 7, COLS = 8, L = "ABCDEFGH";
function syncDims(g) { const r = (g && g.rows) || 7, c = (g && g.cols) || 8; CW.setDims(r, c); ROWS = r; COLS = c; L = CW.L; }
let playerCount = 2;
const APP_VERSION = window.CW_VERSION || "dev";
let updateReady = null; // newer version detected while in a game
// Player name (required before playing) and HTML escaping for anything other players typed.
let myName = (store("cw_name") || "").slice(0, 16);
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const cleanName = t => String(t || "").replace(/\s+/g, " ").trim().slice(0, 16);
let homeScreen = "home"; // home | name | host | browse
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
    .on("broadcast", { event: "hello" }, ({ payload }) => {
      if (!isHost) return;
      if (payload.v !== APP_VERSION) { send("reject", { to: payload.token, reason: "That game is on a different version. Both players: go to the main menu to update, then try again." }); return; }
      hostHello(payload.token, payload.name);
    })
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
  if (isHost) {
    const need = room ? [room.guest, room.guest3].filter(Boolean) : [];
    peerOnline = need.length > 0 && need.every(t => others.some(p => p.token === t));
  } else peerOnline = others.some(p => p.seat === 1);
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
    send("hello", { token, name: myName, v: APP_VERSION });
    if (++tries === 6) { err = "The host isn't responding yet. Still trying…"; render(); }
  };
  // Knock quickly at first (a lost first message shouldn't cost seconds), then back off.
  knock();
  const quick = setTimeout(() => { if (!V) knock(); }, 400);
  joinTimer = setInterval(knock, 900);
  setTimeout(() => clearTimeout(quick), 500);
}

/* ================= matchmaking ================= */
// Everyone searching for a mode joins the presence channel "cw-mm-<mode>". The player who has been
// waiting longest invites the next-longest; the invited player accepts; the inviter hosts a fresh room.
let mm = null; // { mode, ch, since, inviteTo, inviteCode, inviteUntil, done, count }
function mmPlayers() {
  if (!mm || !mm.ch) return [];
  return Object.values(mm.ch.presenceState()).flat().filter(p => p.searching).sort((a, b) => a.since - b.since || (a.token < b.token ? -1 : 1));
}
function mmTick() {
  if (!mm || mm.done) return;
  const list = mmPlayers(), others = list.filter(p => p.token !== token);
  mm.count = list.length;
  const now = Date.now();
  if (mm.inviteTo && now < mm.inviteUntil) return; // waiting on an answer
  mm.inviteTo = null;
  const next = others[0];
  // Only the longer-waiting player of a pair sends the invite, so both sides agree.
  if (next && (mm.since < next.since || (mm.since === next.since && token < next.token))) {
    mm.inviteTo = next.token; mm.inviteCode = randomCode(); mm.inviteUntil = now + 3000;
    mm.ch.send({ type: "broadcast", event: "invite", payload: { from: token, to: next.token, code: mm.inviteCode } });
  }
  if (V === null && !code) render();
}
function startMatchmaking() {
  if (!sb) return;
  stopMatchmaking();
  err = "";
  mm = { mode: gameMode, since: Date.now(), count: 1, done: false };
  const ch = sb.channel("cw-mm-" + APP_VERSION + "-" + gameMode, { config: { broadcast: { self: false }, presence: { key: token } } });
  mm.ch = ch;
  ch.on("presence", { event: "sync" }, () => mmTick())
    .on("broadcast", { event: "invite" }, ({ payload }) => {
      if (!mm || mm.done || payload.to !== token) return;
      mm.done = true;
      ch.send({ type: "broadcast", event: "accept", payload: { from: token, to: payload.from, code: payload.code } });
      const c = payload.code;
      setTimeout(() => { stopMatchmaking(); joinGame(c); }, 150);
    })
    .on("broadcast", { event: "accept" }, ({ payload }) => {
      if (!mm || mm.done || payload.to !== token || payload.code !== mm.inviteCode) return;
      mm.done = true;
      const mode = mm.mode, guest = payload.from, c = payload.code;
      stopMatchmaking();
      createGame(c, { mode, timerOn: true, expectGuest: guest });
    })
    .subscribe(async status => {
      if (status === "SUBSCRIBED") { await ch.track({ token, since: mm.since, searching: true }); mmTick(); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { err = "Can't reach matchmaking. Check your connection."; stopMatchmaking(); render(); }
    });
  mm.timer = setInterval(mmTick, 1000);
  render();
}
function stopMatchmaking() {
  if (!mm) return;
  if (mm.timer) clearInterval(mm.timer);
  if (mm.ch) sb.removeChannel(mm.ch);
  mm = null;
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
  room = newRoom("LOCAL", timerOn, gameMode, playerCount);
  room.guest = "local"; if (room.n === 3) room.guest3 = "local3"; room.phase = "draft";
  room.names = { 1: "Player 1", 2: "Player 2", 3: "Player 3" };
  isHost = true; isLocal = true; localSeat = 1; localHandoff = false; peerOnline = true; code = null;
  sel = []; V = null; lastSeq = -1;
  publish();
}

function newRoom(c, timerOn, mode, n) {
  const m = mode === "tactics" ? "tactics" : "rt";
  return { code: c, names: { 1: myName || "Player 1" }, lobbyName: "", mode: m, n: m === "tactics" && n === 3 ? 3 : 2, guest: null, guest3: null, phase: "lobby", picks: { 1: null, 2: null, 3: null }, starter: 1, game: null,
    timerOn: !!timerOn, deadline: null, timerTurn: null, votes: { rematch: [], redraft: [] } };
}
function saveRoom() { if (room && !isLocal) store("cw_host_" + room.code, JSON.stringify(room)); }

const roomN = () => (room && room.n) || 2;
const seatsOf = () => [...Array(roomN()).keys()].map(i => i + 1);
const tokenSeat = t => (t && t === room.guest ? 2 : t && t === room.guest3 ? 3 : 0);
const allJoined = () => !!room.guest && (roomN() < 3 || !!room.guest3);
function view(seat) {
  const other = opp(seat);
  const n = roomN(), all = seatsOf().every(s => room.picks[s]);
  const both = n === 2 ? !!(room.picks[1] && room.picks[2]) : all;
  return {
    n, joined: 1 + (room.guest ? 1 : 0) + (room.guest3 ? 1 : 0), names: room.names || {}, lobbyName: room.lobbyName || "",
    allPicks: all ? room.picks : null,
    othersLocked: seatsOf().filter(s => s !== seat && room.picks[s]).length,
    code: room.code, matched: !!room.expectGuest, local: isLocal, mode: room.mode || "tactics", hostNow: Date.now(), seat, phase: room.phase, timerOn: room.timerOn,
    opponentJoined: seat === 1 ? !!room.guest : true,
    opponentConnected: seat === 1 ? peerOnline : true,
    myPicks: room.picks[seat], oppLocked: n === 2 ? !!room.picks[other] : seatsOf().every(s => s === seat || room.picks[s]), oppPicks: both && n === 2 ? room.picks[other] : null,
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
  if (room.guest3) send("state", { to: room.guest3, view: view(3) });
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
  room.game = CW.newGame(room.starter, { players: roomN() });
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
    const pool = room.mode === "rt" ? RT.POOL : Object.keys(AB).filter(id => !AB[id].only || AB[id].only === "tactics");
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || !ids.every(id => pool.includes(id))) return "Pick exactly 3 different abilities.";
    if (room.picks[seat]) return "You already locked in.";
    room.picks[seat] = ids.slice();
    if (seatsOf().every(s => room.picks[s])) startMatch();
    return null;
  }
  if (type === "vote") {
    if (!room.game || !room.game.over) return null;
    const kind = p.kind; if (kind !== "rematch" && kind !== "redraft") return null;
    const other = kind === "rematch" ? "redraft" : "rematch";
    room.votes[other] = room.votes[other].filter(s => s !== seat);
    if (!room.votes[kind].includes(seat)) room.votes[kind].push(seat);
    if (room.votes[kind].length === roomN()) {
      room.starter = (room.starter % roomN()) + 1;
      if (kind === "rematch") startMatch();
      else { room.phase = "draft"; room.picks = { 1: null, 2: null, 3: null }; room.game = null; room.votes = { rematch: [], redraft: [] }; clearTimer(); room.deadline = null; }
    }
    return null;
  }
  if (type === "drop" || type === "ability") {
    const g = room.game;
    if (room.phase !== "play" || !g || g.over) return "No active match.";
    if (room.mode === "rt") {
      const a = { id: p.id, c: Number(p.c), r: Number(p.r), r2: Number(p.r2), c2: Number(p.c2), dir: p.dir === "left" || p.dir === "right" ? p.dir : null };
      return type === "drop" ? RT.drop(g, seat, Number(p.c), Date.now()) : RT.ability(g, seat, a, room.picks[seat], Date.now());
    }
    if (seat !== g.cur) return "It's not your turn.";
    let e;
    if (type === "drop") e = CW.drop(g, Number(p.c));
    else e = CW.ability(g, { id: p.id, c: Number(p.c), r: Number(p.r), r2: Number(p.r2), c2: Number(p.c2), dir: p.dir === "left" || p.dir === "right" ? p.dir : null }, room.picks[seat]);
    if (e) return e;
    if (g.over) { clearTimer(); room.deadline = null; } else armTimer(type === "ability" && ["flip", "pop", "gravity", "rotate", "shift"].includes(p.id) ? 1000 : 0);
    return null;
  }
  return "Unknown action.";
}

function hostHello(t, name) {
  if (!room) return;
  if (!room.guest && room.expectGuest && room.expectGuest !== t) { send("reject", { to: t, reason: "That game is reserved for a matched player." }); return; }
  if (!tokenSeat(t)) {
    if (!room.guest) room.guest = t;
    else if (roomN() === 3 && !room.guest3) room.guest3 = t;
    else { send("reject", { to: t, reason: `That game already has ${roomN()} players.` }); return; }
  }
  const st = tokenSeat(t);
  if (st) { room.names = room.names || {}; room.names[st] = cleanName(name) || `Player ${st}`; }
  if (room.phase === "lobby" && allJoined()) room.phase = "draft";
  lobbyAdvertise();
  computePeer();
  publish();
}
function hostAction(msg) {
  const seat = room ? tokenSeat(msg.token) : 0;
  if (!seat) return;
  const e = handle(seat, msg.type, msg.p);
  send("ack", { to: msg.token, id: msg.id, res: e ? { error: e } : { ok: true } });
  if (!e) publish();
}

/* ================= actions from this device ================= */
function act(type, p, cb) {
  if (isHost) {
    let seat = 1;
    if (isLocal) {
      if (type === "vote") { seatsOf().forEach(st => handle(st, type, p)); if (room.phase === "draft") { localSeat = 1; localHandoff = false; sel = []; } cb && cb({ ok: true }); return publish(); }
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

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
/* ================= lobby directory ================= */
// Open lobbies live in the Supabase table "lobbies". The host refreshes its row every 5s while the lobby
// is open; Find lobby re-reads the list every 5s and only shows rows refreshed in the last 20s.
let dir = { list: [], ready: false, at: 0, err: "" }; // what Find lobby shows
let browseTimer = null, hostBeat = null, advertisedCode = null;
async function fetchLobbies() {
  if (!sb) return;
  const { data, error } = await sb.rpc("open_lobbies", { p_version: APP_VERSION });
  dir.ready = true; dir.at = Date.now();
  if (error) { dir.err = "Couldn't load lobbies. Retrying…"; }
  else { dir.err = ""; dir.list = (data || []).filter(l => !(room && l.code === room.code)); }
  if (!V && homeScreen === "browse") render();
}
function startBrowsing() {
  stopBrowsing();
  dir = { list: [], ready: false, at: 0, err: "" };
  fetchLobbies();
  browseTimer = setInterval(fetchLobbies, 5000);
}
function stopBrowsing() { if (browseTimer) clearInterval(browseTimer); browseTimer = null; }
function dirOpen() { /* list connection is now on demand (Find lobby) */ }
// Host: stop advertising this lobby.
function dirClose() {
  if (hostBeat) clearInterval(hostBeat); hostBeat = null;
  if (advertisedCode && sb) { const c = advertisedCode; advertisedCode = null; sb.from("lobbies").delete().eq("code", c).then(() => {}, () => {}); }
}
// Host: publish (or withdraw) this room in the lobby list, refreshing it every 5 seconds.
function lobbyAdvertise() {
  if (!sb || !room || isLocal || room.expectGuest) return;
  const joined = 1 + (room.guest ? 1 : 0) + (room.guest3 ? 1 : 0);
  const open = room.phase === "lobby" && joined < roomN();
  if (!open) { dirClose(); return; }
  const row = () => ({ code: room.code, name: (room.lobbyName || `${room.names[1]}'s Lobby`).slice(0, 40), host: String(room.names[1] || "Host").slice(0, 20),
    mode: room.mode, n: roomN(), joined: 1 + (room.guest ? 1 : 0) + (room.guest3 ? 1 : 0), version: APP_VERSION });
  const beat = () => {
    if (!room || room.phase !== "lobby") return dirClose();
    sb.from("lobbies").upsert(row(), { onConflict: "code" }).then(({ error }) => { if (error) console.warn("lobby heartbeat failed", error.message); });
  };
  advertisedCode = room.code;
  beat();
  if (!hostBeat) hostBeat = setInterval(beat, 5000);
}
// Withdraw the lobby if the host closes the tab.
window.addEventListener("pagehide", () => { if (advertisedCode) dirClose(); });

function createGame(fixedCode, opts = {}) {
  const c = fixedCode || randomCode();
  room = newRoom(c, opts.timerOn ?? timerOn, opts.mode || gameMode, opts.players || (opts.mode ? 2 : playerCount));
  if (opts.expectGuest) room.expectGuest = opts.expectGuest;
  room.lobbyName = opts.lobbyName || "";
  store("cw_room", c); store("cw_role", "host");
  history.replaceState(null, "", "#" + c);
  openChannel(c, true);
  publish();
  lobbyAdvertise();
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
  openChannel(c, false);
  err = "Connecting…"; render();
}
function leaveLocal() {
  stopMatchmaking(); dirClose(); stopBrowsing(); homeScreen = "home";
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
let mode = null, swapSel = null, localMsg = "", rowSel = null;
let lastSeq = -1, lastOver = false, showOver = false, flip = null, busy = false, confirmMenu = false;
// Short animations in flight. Re-renders resume them part-way (negative animation-delay) instead of restarting or dropping them.
let fx = [];
// How long a move's on-screen motion lasts (first phase + the discs settling), so scoring
// effects wait until every disc has arrived. One table for every move type.
const PHASE1_MS = { flip: 560, pop: 420, gravity: 340, rotate: 620, shift: 460, insert: 460, boom: 520 };
const FALL_MS = 450;
function moveLeadMs(ev) {
  if (!ev) return 0;
  const t = ev.type;
  if (PHASE1_MS[t] !== undefined) return PHASE1_MS[t] + FALL_MS;            // two-phase moves
  if (t === "drop" || t === "block") return FALL_MS;
  if (t === "punch") return (ev.from !== undefined && ev.from !== ev.r ? FALL_MS : 0) + 650;
  if (t === "swap") return 500;
  if (t === "reinforce") return 450;
  if (t === "lift") return 600;
  return 0;
}
let winAt = 0; // when the winning four may light up (after the winning move has animated)
const FX_MS = { banner: 1500, punch: 650, drop: 450, freeze: 650, anchor: 550, swap: 500, lift: 600, double: 750, score: 900, contest: 1100, reinforce: 450 };
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
  syncDims(v.game);
  if (joinTimer && !isHost) { clearInterval(joinTimer); joinTimer = null; }
  if (!isHost) v.opponentConnected = peerOnline;
  const g = v.game;
  if (V && V.phase !== "play" && v.phase === "play") { lastSeq = -1; lastOver = false; showOver = false; }
  if (g) {
    if (g.seq !== lastSeq) {
      flip = null; busy = false;
      if (lastSeq !== -1 && g.ev && g.ev.ability) fx.push({ type: "banner", ability: g.ev.ability, by: g.ev.by, start: fxNow() });
      if (lastSeq !== -1 && g.ev && g.ev.scores) {
        const lead = moveLeadMs(g.ev);
        const cells = g.ev.scores.flatMap(sc => sc.cells), owner = {};
        g.ev.scores.forEach(sc => sc.cells.forEach(k => { owner[k] = sc.p; }));
        fx.push({ type: "score", petrify: cells, owner, start: fxNow() + lead });
        setTimeout(() => { if (!busy) render(); }, lead + 20);
      }
      if (lastSeq !== -1 && g.ev) {
        const t = g.ev.type;
        // Discs that this move turns to stone still have to travel with everything else first.
        const pend = new Set(g.ev.scores ? g.ev.scores.flatMap(sc => sc.cells) : []);
        if (t === "flip" || t === "pop" || t === "gravity") flip = { type: t, c: g.ev.c, prev: g.ev.prev, phase: 1, settle: t === "gravity" && g.ev.prev ? settleMap(g.ev.prev, g, pend) : null };
        else if (t === "rotate" || t === "shift" || t === "insert") flip = { type: t, dir: g.ev.dir || g.ev.side, r: g.ev.r, ev_r: g.ev.r, ev_c: g.ev.c, knock: g.ev.knock || null, broke: g.ev.broke ?? null, prev: g.ev.prev, mid: g.ev.mid, settle: settleMap(g.ev.mid, g, pend), phase: 1 };
        else if (g.ev.clears && g.ev.prev) flip = { type: "clear", prev: g.ev.prev, clears: g.ev.clears, phase: 1, ev: g.ev };
        else fx.push({ ...g.ev, type: t === "block" ? "drop" : t, start: fxNow() });
      }
      if (v.mode === "rt" && !g.over) {
        localMsg = "";
        if (swapSel && !CW.validCell({ ...g, cur: v.local ? modeSeat : v.seat }, "swap", swapSel[0], swapSel[1], null)) swapSel = null;
      } else { mode = null; swapSel = null; rowSel = null; localMsg = ""; }
      if (g.over && !lastOver) {
        showOver = lastSeq === -1;
        // Let the move that won play out before the four lights up.
        const t = g.ev && g.ev.type;
        let moveMs = lastSeq === -1 ? 0 : moveLeadMs(g.ev) + 60;
        if (moveMs && g.ev && g.ev.scores) moveMs += 850; // let the four turn to stone first
        winAt = fxNow() + moveMs;
        if (moveMs) setTimeout(() => { if (V && V.game && V.game.over && !busy) render(); }, moveMs + 30);
        if (!showOver) setTimeout(() => {
          showOver = true;
          const w = document.querySelector(".board-wrap");
          if (w && V && V.game && V.game.over && !w.querySelector(".over")) w.insertAdjacentHTML("beforeend", overHtml());
        }, moveMs + (g.result ? 2200 : 900));
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
    setTimeout(() => { if (flip === f) { flip.phase = 2; busy = false; render(); flip = null; } }, f.type === "pop" ? 420 : f.type === "clear" ? (f.ev && f.ev.type === "boom" ? 520 : 820) : f.type === "gravity" ? 340 : f.type === "rotate" ? 620 : f.type === "shift" || f.type === "insert" ? 460 : 560);
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
const nameOf = p => (V && V.names && V.names[p]) || (V && V.n === 3 ? `Player ${p}` : "Opponent");
const you = p => (V && V.local ? `Player ${p}` : V && p === V.seat ? "You" : esc(nameOf(p)));
// Swap "Player N" in engine notes for "You" / that player's name.
const named = t => (V && V.local ? t : String(t || "").replace(/Player (\d)/g, (m, d) => you(+d)));
const picksOf = p => (V.allPicks && V.allPicks[p]) || (p === V.seat ? V.myPicks : V.oppPicks);
const turnOrder = () => { const n = V.n || 2, out = []; for (let i = 0, p = V.seat; i < n; i++, p = (p % n) + 1) out.push(p); return out; };
const localName = text => text; // local mode keeps "Player 1/2" wording

function render() {
  renderScreen();
  if (updateReady && !V && !mm && !code && !isLocal && tryReload(updateReady)) return;
  if (updateReady) app.insertAdjacentHTML("afterbegin", `<div class="banner">${V ? "A new version is ready. It loads when you go back to the main menu." : "A new version is out. Pull down to refresh, or close and reopen the page."}</div>`);
  if (confirmMenu) app.insertAdjacentHTML("beforeend", menuModal());
}
function renderScreen() {
  if (localHandoff) return renderHandoff();
  if (mm && !V) return renderSearching();
  if (!V && code && !isHost) return renderJoining();
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
  const a = localSeat, b = localSeat + 1;
  app.innerHTML = `${header()}
  <section class="handoff">
    <div class="eyebrow c${a}">Player ${a} locked in</div>
    <h2>Pass the phone to Player ${b}</h2>
    <p class="muted">Everyone else, look away while Player ${b} picks.</p>
    <button class="primary" data-act="p2ready">I'm Player ${b}</button>
  </section>`;
}

function renderJoining() {
  app.innerHTML = `${header()}
  <section class="handoff">
    <div class="eyebrow">Lobby</div>
    <div class="radar" aria-hidden="true"><i></i><i></i><i></i></div>
    <h2>Joining…</h2>
    <p class="muted">${err && err !== "Connecting…" ? esc(err) : "Connecting to the host."}</p>
    <button class="ghost" data-act="leave">Cancel</button>
  </section>`;
}

function renderSearching() {
  const n = Math.max(0, (mm.count || 1) - 1);
  app.innerHTML = `${header()}
  <section class="handoff">
    <div class="eyebrow">${mm.mode === "rt" ? "Connect War: Full Auto" : "Connect War"} · Matchmaking</div>
    <div class="radar" aria-hidden="true"><i></i><i></i><i></i></div>
    <h2>Finding an opponent…</h2>
    <p class="muted">${n ? `${n} other player${n === 1 ? "" : "s"} searching. Pairing you now.` : "No one else is searching yet. You'll be matched as soon as someone joins."}</p>
    <button class="ghost" data-act="mm-cancel">Cancel</button>
    <p class="err">${err}</p>
  </section>`;
}

const three = () => gameMode === "tactics" && playerCount === 3;
const modeLabel = m => (m === "rt" ? "Connect War: Full Auto" : "Connect War");
function modeOptions() {
  return `<div class="modes">
      <button class="mode ${gameMode === "tactics" ? "on" : ""}" data-mode="tactics" aria-pressed="${gameMode === "tactics"}"><span class="cn">Connect War</span><span class="cd">Turn based with energy. One four wins.</span></button>
      <button class="mode ${gameMode === "rt" ? "on" : ""}" data-mode="rt" aria-pressed="${gameMode === "rt"}"><span class="cn">Connect War: Full Auto</span><span class="cd">Real time. No turns: drop charges and ability cooldowns. Scored fours turn to stone. First to 5 in 5 minutes.</span></button>
    </div>
    ${gameMode === "tactics" ? `<div class="seg" role="group" aria-label="Players">
      <span class="seg-l">Players</span>
      <button class="${playerCount === 2 ? "on" : ""}" data-players="2" aria-pressed="${playerCount === 2}">2</button>
      <button class="${playerCount === 3 ? "on" : ""}" data-players="3" aria-pressed="${playerCount === 3}">3</button>
    </div>
    <label class="tog"><input type="checkbox" id="timerOn" ${timerOn ? "checked" : ""}> 20-second turn clock</label>` : ""}
    ${three() ? `<p class="muted small">3 players: bigger 10×8 board, turns go 1 → 2 → 3. Freeze and Pop hit both opponents. Find match is 2-player only.</p>` : ""}`;
}

function renderName() {
  app.innerHTML = `${header()}
  <section class="setup">
    <h2>${myName ? "Change your name" : "Choose your name"}</h2>
    <p class="muted">Other players see this in lobbies and during matches.</p>
    <form class="field" id="nameForm"><input id="nameIn" maxlength="16" placeholder="Your name" autocomplete="nickname" value="${esc(myName)}" aria-label="Your name" style="letter-spacing:.04em;text-transform:none;font-size:18px;text-align:left"><button class="primary" type="submit">Save</button></form>
    ${myName ? `<button class="ghost" data-act="home">Back</button>` : ""}
    <p class="err">${err}</p>
  </section>`;
  const i = document.getElementById("nameIn"); if (i) i.focus();
}

function renderHostForm() {
  app.innerHTML = `${header()}
  <section class="setup">
    <div class="eyebrow">Host a lobby</div>
    <h2>${esc(modeLabel(gameMode))}${three() ? " · 3 players" : ""}</h2>
    <form class="setup" id="hostForm" style="gap:10px">
      <label class="muted small" for="lobbyIn">Lobby name</label>
      <input id="lobbyIn" class="textin" maxlength="28" placeholder="${esc(myName)}'s Lobby" autocomplete="off">
      <button class="primary" type="submit">Open lobby</button>
    </form>
    <button class="ghost" data-act="home">Back</button>
  </section>`;
}

function renderBrowse() {
  const d = dir, list = d ? d.list : [];
  app.innerHTML = `${header()}
  <section class="setup">
    <div class="eyebrow">Find lobby</div>
    <h2>Open lobbies</h2>
    ${!d.ready ? `<p class="muted">Loading lobbies…</p>` : list.length ? `<ul class="lobbies">${list.map(l => `
      <li><button class="lobby" data-joinlobby="${esc(l.code)}">
        <span class="lb-name">${esc(l.name)}</span>
        <span class="lb-meta">${esc(modeLabel(l.mode))} · hosted by ${esc(l.host)}</span>
        <span class="lb-seats">${l.joined}/${l.n}</span></button></li>`).join("")}</ul>`
      : `<p class="muted">No open lobbies right now. Host one, or try Find match.</p>`}
    <div class="refreshrow"><span class="muted small">${d.err ? esc(d.err) : d.ready ? "Refreshes every 5 seconds" : ""}</span><button class="linkbtn" data-act="refresh-lobbies">Refresh now</button></div>
    <button class="ghost" data-act="home">Back</button>
    <p class="muted small">Version ${esc(APP_VERSION)}</p>
    <p class="err">${err}</p>
  </section>`;
}

function renderHome() {
  if (homeScreen === "name" || !myName) return renderName();
  if (homeScreen === "host") return renderHostForm();
  if (homeScreen === "browse") return renderBrowse();
  const waiting = code && !isHost;
  app.innerHTML = `${header()}
  <section class="setup">
    <div class="who"><span>Playing as <b>${esc(myName)}</b></span><button class="linkbtn" data-act="rename">Change</button></div>
    <h2>New game</h2>
    ${modeOptions()}
    <button class="primary" data-act="matchmake" ${sb && !three() ? "" : "disabled"}>Find match</button>
    <div class="row2">
      <button class="ghost strong" data-act="hostform" ${sb ? "" : "disabled"}>Host lobby</button>
      <button class="ghost strong" data-act="browse" ${sb ? "" : "disabled"}>Find lobby</button>
    </div>
    <button class="ghost strong" data-act="local">Play local</button>
    <p class="muted small">Find match: play the next person searching. Host or find a lobby to play friends. Local: everyone on this phone${gameMode === "rt" ? ", one at each end" : ", passing it between turns"}.</p>
    ${sb ? "" : `<p class="err">Online play is unavailable: the game server didn't load. Local play still works.</p>`}
    <p class="err">${err}</p>
    ${waiting ? `<button class="ghost" data-act="leave">Cancel</button>` : ""}
    ${!waiting && store("cw_room") && store("cw_room") !== "LOCAL" ? `<button class="ghost" data-act="rejoin">Rejoin last game</button>` : ""}
    <button class="linkbtn" data-act="reset">Stuck? Reset saved games</button>
  </section>`;
}

function renderLobby() {
  if (V.matched) {
    app.innerHTML = `${header()}<section class="handoff"><div class="eyebrow">${modeName()} · Matchmaking</div>
      <div class="radar" aria-hidden="true"><i></i><i></i><i></i></div><h2>Opponent found</h2><p class="muted">Connecting…</p><p class="err">${err}</p></section>`;
    return;
  }
  const n = V.n || 2, names = V.names || {};
  const lname = V.lobbyName || `${names[1] || "Host"}'s Lobby`;
  app.innerHTML = `${header()}
  <section class="setup">
    <div class="eyebrow">${modeName()}${n === 3 ? " · 3 players" : ""} · Lobby</div>
    <h2>${esc(lname)}</h2>
    <ul class="seats">${[...Array(n).keys()].map(i => i + 1).map(p => `<li class="c${p}"><span class="dot d${p === 3 ? 6 : p}"></span>${names[p] ? esc(names[p]) + (p === V.seat ? " (you)" : "") : `<span class="muted">Waiting for player…</span>`}</li>`).join("")}</ul>
    <p class="muted">${V.seat === 1 ? "Your lobby is listed under Find lobby. Keep this page open: your device runs the match." : "Waiting for the lobby to fill…"}</p>
    <button class="ghost" data-act="leave">${V.seat === 1 ? "Close lobby" : "Leave lobby"}</button>
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
      <p class="muted">${V.oppLocked ? "Starting…" : (V.n || 2) === 3 ? `Waiting for ${2 - (V.othersLocked || 0)} more player${2 - (V.othersLocked || 0) === 1 ? "" : "s"} to pick.` : "Waiting for your opponent to pick."}</p>
      ${dc}
    </section>`;
    return;
  }
  app.innerHTML = `${header()}
  <section class="setup" data-p="${p}">
    <div class="eyebrow c${p}">${modeName()} · ${V.local ? "Local · " : ""}${V.local ? "" : "You are "}Player ${p}</div>
    <h2>${V.local ? `Player ${p}: pick 3 abilities` : "Pick 3 abilities"}</h2>
    <p class="muted">${V.local ? "Everyone else, look away. Picks stay hidden until the match starts." : ((V.n || 2) === 3 ? `Picks stay hidden until everyone locks in. ${V.othersLocked ? `${V.othersLocked} of 2 others locked in.` : ""}` : `Your opponent can't see your picks until both of you lock in. ${V.oppLocked ? "Your opponent has locked in." : ""}`)}</p>
    ${dc}
    <div class="cards">${Object.entries(AB).filter(([id, a]) => (isRT() ? RT.POOL.includes(id) : !a.only || a.only === "tactics")).map(([id, a]) => `<button class="card ${sel.includes(id) ? "on" : ""}" data-pick="${id}" aria-pressed="${sel.includes(id)}">
      <span class="cn">${a.name}</span><span class="cost">${costLabel(id)}</span><span class="cd">${descOf(id)}</span></button>`).join("")}</div>
    <button class="primary" data-act="lock" ${sel.length === 3 ? "" : "disabled"}>Lock in (${sel.length}/3)</button>
    <p class="err">${err}</p>
  </section>`;
}

const modeName = () => (V && V.mode === "rt" ? "Connect War: Full Auto" : "Connect War");
const costLabel = id => (isRT() ? RT.CD[id] / 1000 + "s" : AB[id].cost + " EN");
const descOf = id => (isRT() ? RT.DESC[id] : AB[id].desc);
const frozenCols = (g, p) => (isRT() ? g.frozen.filter(f => f.player === p && f.until > hostNow()) : g.frozen && (g.frozen.players ? g.frozen.players.includes(p) : g.frozen.player === p) ? [g.frozen] : []);

function panelRT(p) {
  const g = V.game, s = g.score[p], fz = frozenCols(g, p);
  const picks = picksOf(p);
  return `<div class="pl" data-p="${p}">
    <div class="nm"><b>${you(p)}</b><span class="score">${s}</span></div>
    <div class="pips" aria-label="${s} of ${RT.TARGET} points">${Array.from({ length: RT.TARGET }, (_, i) => `<i class="pt ${i < s ? "f" : ""}"></i>`).join("")}<span>${s}/${RT.TARGET}</span></div>
    <div class="lo">${(picks || []).map(id => AB[id].name).join(" · ")}${fz.length ? `<br>Column ${fz.map(f => L[f.col]).join(", ")} frozen` : ""}</div>
  </div>`;
}

function panel(p) {
  if (isRT()) return panelRT(p);
  const g = V.game, e = g.energy[p], fz = frozenCols(g, p).length > 0;
  const picks = picksOf(p);
  const on = g.cur === p && !g.over;
  return `<div class="pl ${on ? "on" : ""}" data-p="${p}">
    <div class="nm"><b>${you(p)}</b>${on ? '<span class="turn">Turn</span>' : `<span class="score" title="Fours">${(g.score && g.score[p]) || 0}</span>`}</div>
    <div class="fours" aria-label="${(g.score && g.score[p]) || 0} of ${CW.TARGET} fours">${Array.from({ length: CW.TARGET }, (_, i) => `<i class="${i < ((g.score && g.score[p]) || 0) ? "f" : ""}"></i>`).join("")}<span>fours</span></div>
    <div class="pips" aria-label="${e} of ${MAXE} energy">${Array.from({ length: MAXE }, (_, i) => `<i class="${i < e ? "f" : ""}"></i>`).join("")}<span>${e}/${MAXE}</span></div>
    <div class="lo">${(picks || []).map(id => AB[id].name).join(" · ")}${fz ? `<br>Column ${L[g.frozen.col]} frozen` : ""}</div>
  </div>`;
}

const PROMPT = {
  block: () => "Block: tap a column to drop a neutral stone.",
  freeze: () => `Freeze: tap a column to lock it for ${V && V.n === 3 ? "both opponents' next turns" : "your opponent's next turn"}.`,
  anchor: () => "Anchor: tap one of your discs.",
  lift: () => "Lift: tap a column whose top disc is yours.",
  pop: () => `Pop: tap a column whose ${V && V.game && V.game.gdir === -1 ? "top" : "bottom"} disc is ${V && V.n === 3 ? "an opponent's" : "your opponent's"}.`,
  swap: () => "Swap: tap a disc, then an adjacent disc of the other color.",
  flip: () => "Flip: tap a column with 2 or more discs.",
  insert: () => "Insert: tap a glowing slot on the left or right edge. Your disc slides in from that side.",
  rotate: () => "Rotate: pick Turn left or Turn right. That side of the board becomes the floor.",
  shift: () => (rowSel === null ? "Shift: tap any cell in the row you want to slide." : "Shift: pick a direction."),
  punch: () => "Punch In: tap any cell that isn't an enemy disc.",
  reinforce: () => `Reinforce: tap a column to slide your disc in from the ${V && V.game && V.game.gdir === -1 ? "top" : "bottom"}.`,
  grenade: () => "Grenade: tap a column to drop it. It explodes 2 seconds later."
};

// Describes the move that just happened, without revealing its result yet.
function moveText(g) {
  const ev = g.ev || {}, who = you(ev.by || g.result || 0);
  if (ev.ability && AB[ev.ability]) return `${who} used ${AB[ev.ability].name}.`;
  if (ev.type === "drop" && typeof ev.c === "number") return `${you(g.result)} dropped in ${L[ev.c]}.`;
  return "";
}
function statusText() {
  const g = V.game;
  if (localMsg) return localMsg;
  if (g.over && g.win && g.win.length && (flip || fxNow() < winAt)) return moveText(g) || "…";
  if (isRT()) {
    if (g.over && V.local) return `Player ${g.result} wins ${g.score[g.result]}–${g.score[opp(g.result)]}.`;
    if (g.over) return g.result === V.seat ? `You win ${g.score[V.seat]}–${g.score[opp(V.seat)]}.` : `You lose ${g.score[V.seat]}–${g.score[opp(V.seat)]}.`;
    if (mode) return (mode === "freeze" ? "Freeze: tap a column to lock it for your opponent for 5 seconds." : PROMPT[mode]());
    const nt = named(g.note);
    return (g.sudden ? "<b>Sudden death</b>: next score wins. " : "") + (nt || "Go! Drop discs as fast as your cooldowns allow.");
  }
  if (g.over && V.local) return g.result ? `Player ${g.result} wins with ${CW.TARGET} fours.` : "Draw.";
  if (g.over) return g.result ? (g.result === V.seat ? `You win with ${CW.TARGET} fours.` : `${you(g.result)} wins with ${CW.TARGET} fours.`) : "Draw.";
  if (mode) return PROMPT[mode]();
  if (V.local) {
    const who = `<b class="c${g.cur}">Player ${g.cur}</b>`;
    const nl = g.note ? g.note + " " : "";
    if (g.dd && g.dropsMade === 1) return nl + who + ": place your second disc in a different column. It can't complete a 4.";
    if (g.abilityUsed && g.dropsMade === 0 && !g.dd) return nl + who + ": now drop a disc.";
    return nl + who + ": drop a disc, or use an ability first.";
  }
  const note = g.note ? named(g.note) + " " : "";
  if (g.cur === V.seat) {
    if (g.dd && g.dropsMade === 1) return note + "Place your second disc in a different column. It can't complete a 4.";
    if (g.abilityUsed && g.dropsMade === 0 && !g.dd) return note + "<b>Your turn</b>: now drop a disc.";
    return note + "<b>Your turn</b>: drop a disc, or use an ability first.";
  }
  return note + `<b class="c${g.cur}">${you(g.cur)}</b>'s turn.`;
}

function overHtml() {
  const g = V.game, other = opp(V.seat);
  const r = V.votes.rematch, d = V.votes.redraft;
  const title = g.result ? (V.local ? `Player ${g.result} wins` : g.result === V.seat ? "You win" : (V.n || 2) === 3 ? `${you(g.result)} wins` : "You lose") : "Draw";
  const n = V.n || 2;
  // One button: Rematch always goes back to the loadout screen (it votes "redraft" under the hood).
  const others = d.filter(s => s !== V.seat).length, mine = d.includes(V.seat);
  const sub = others ? (n === 3 ? `${others} of ${n - 1} others want a rematch.` : "Your opponent wants a rematch.") : "";
  return `<div class="over"><div class="box">
    <div class="eyebrow ${g.result ? "c" + g.result : ""}">Match over</div>
    <h2>${title}</h2>
    ${isRT() ? `<p class="muted">${V.local ? `Player 1 ${g.score[1]} – ${g.score[2]} Player 2` : `${g.score[V.seat]}–${g.score[other]}`}${g.sudden ? " in sudden death" : ""}</p>`
      : g.score ? `<p class="muted">${[...Array(V.n || 2).keys()].map(i => i + 1).map(p => `${you(p)} ${g.score[p] || 0}`).join(" · ")}</p>` : ""}
    ${sub ? `<p class="muted">${sub}</p>` : ""}
    <button class="primary" data-act="redraft" ${mine && !V.local ? "disabled" : ""}>${mine && !V.local ? (n === 3 ? "Waiting for others" : "Waiting for opponent") : "Rematch"}</button>
    <button class="ghost" data-act="leave">Leave game</button></div></div>`;
}

// After fours are removed, discs that were above them fall by the number removed in that column.
const gravCls = () => (flip && flip.phase === 1 && flip.type === "gravity" ? "grav1" : "");
function bannerHtml() {
  const b = fxFind("banner");
  if (!b || !AB[b.ability]) return "";
  return `<div class="ability-banner p${b.by}" style="${b.ad}" aria-live="polite" aria-label="${esc(you(b.by))} used ${AB[b.ability].name}"><span class="ab-name">${AB[b.ability].name}</span></div>`;
}
const vShowPending = key => !!fx.find(f => f.type === "score" && f.owner && f.start > fxNow() && f.petrify.includes(key));
// Insert: an open slot on the left or right edge picks both the row and the side.
const insertSide = (g, r, c) => (c === 0 && CW.sideOpen(g, r, "left") ? "left" : c === COLS - 1 && CW.sideOpen(g, r, "right") ? "right" : null);
// Arrows drawn on the board while choosing a direction (they can be tapped too).
const ARC = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 12 A20 20 0 1 1 12 32" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M12 19 L3 35 L21 35 Z" fill="currentColor"/></svg>';
const CHEV = '<svg viewBox="0 0 48 32" aria-hidden="true"><path d="M4 16 H36" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M28 5 L44 16 L28 27 Z" fill="currentColor"/></svg>';
function dirOverlay(g, seat) {
  if (!(mode === "rotate" || (mode === "shift" && rowSel !== null))) return "";
  if (mode === "rotate") return `<div class="diroverlay rot">
    <button class="arrowbtn rot-l" data-dir="left" aria-label="Turn the board left">${ARC}<span>Turn left</span></button>
    <button class="arrowbtn rot-r" data-dir="right" aria-label="Turn the board right">${ARC}<span>Turn right</span></button></div>`;
  const top = `calc(${(rowSel + 0.5) / ROWS} * 100%)`;
  if (mode === "shift") return `<div class="diroverlay">
    <div class="rowband" style="top:${top};height:calc(100% / ${ROWS})"></div>
    <button class="arrowbtn edge out-l" style="top:${top}" data-dir="left" aria-label="Shift row left">${CHEV}</button>
    <button class="arrowbtn edge out-r" style="top:${top}" data-dir="right" aria-label="Shift row right">${CHEV}</button></div>`;
  const okL = CW.sideOpen(g, rowSel, "left"), okR = CW.sideOpen(g, rowSel, "right");
  return `<div class="diroverlay">
    <div class="rowband" style="top:${top};height:calc(100% / ${ROWS})"></div>
    <button class="arrowbtn edge in-l" style="top:${top}" data-dir="left" ${okL ? "" : "disabled"} aria-label="Insert from the left">${CHEV}</button>
    <button class="arrowbtn edge in-r" style="top:${top}" data-dir="right" ${okR ? "" : "disabled"} aria-label="Insert from the right">${CHEV}</button></div>`;
}
// Left/right buttons for Rotate, Shift and Insert.
function choiceHtml(g) {
  if (!(mode === "rotate" || (mode === "shift" && rowSel !== null))) return "";
  const lab = { rotate: ["⟲ Turn left", "Turn right ⟳"], shift: ["← Shift left", "Shift right →"], insert: ["→ From left", "From right ←"] }[mode];
  const dis = d => (mode === "insert" && !CW.sideOpen(g, rowSel, d) ? "disabled" : "");
  return `<div class="choice"><button class="primary" data-dir="left" ${dis("left")}>${lab[0]}</button><button class="primary" data-dir="right" ${dis("right")}>${lab[1]}</button></div>`;
}
// How far each disc falls between two boards (column by column, movable pieces keep their order).
function settleMap(from, to, pend) {
  const out = {}, R = to.grid.length, C = to.grid[0].length, upG = to.gdir === -1;
  pend = pend || new Set();
  for (let c = 0; c < C; c++) {
    const a = [], b = [];
    for (let i = 0; i < R; i++) {
      const r = upG ? i : R - 1 - i; // floor side first
      const va = from.grid[r][c], vb = to.grid[r][c];
      if (va && va !== 5) a.push(r);
      if (vb && (vb !== 5 || pend.has(r + "," + c))) b.push(r);
    }
    b.forEach((r, i) => { if (a[i] !== undefined && a[i] !== r) out[r + "," + c] = Math.abs(a[i] - r); });
  }
  return out;
}
function clearedFall(f, r, c, gup) {
  let n = 0, maxRow = -1, minRow = ROWS;
  for (const grp of f.clears) for (const k of grp.cells) { const [rr, cc] = k.split(",").map(Number); if (cc === c) { n++; maxRow = Math.max(maxRow, rr); minRow = Math.min(minRow, rr); } }
  if (!n) return 0;
  return gup ? (r >= minRow - n ? n : 0) : (r <= maxRow ? n : 0);
}

function renderPlay() {
  syncDims(flip && flip.phase === 1 && flip.type === "rotate" ? flip.prev : V.game);
  const rt = isRT(), now = hostNow();
  const g0 = V.game, g = rt ? { ...g0, cur: V.local ? modeSeat : V.seat } : g0;
  const myTurn = rt ? !g.over && !busy : g.cur === V.seat && !g.over && !busy;
  const canDropCol = c => (rt ? RT.canDrop(g, V.seat, c, now) : CW.canDrop(g, c));
  const shownSrc = flip && flip.phase === 1 ? (flip.type === "shift" || flip.type === "insert" ? flip.mid : flip.prev) : null;
  const shown = shownSrc ? { ...g, grid: shownSrc.grid, anc: shownSrc.anc } : g;
  const cleared = new Map();
  if (flip && flip.type === "clear") {
    flip.clears.forEach(f => f.cells.forEach((k, i) => cleared.set(k, i)));
  }
  const pend = rt && g.pending ? new Set(g.pending.cells) : null;
  const mt = mode ? AB[mode].t : null;
  const showWin = g.over && !flip && fxNow() >= winAt;
  const wins = new Map(showWin ? g.win.map((k, i) => [k, i]) : []);
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
    const fzHere = !g.over && (rt ? g.frozen.find(f => f.col === c && f.until > now) : g.frozen && g.frozen.col === c ? g.frozen : null);
    if (fzHere) cls += " frz" + (fzHere.by ? " frzby" + fzHere.by : "");
    let cells = "";
    for (let r = 0; r < ROWS; r++) {
      const v = shown.grid[r][c]; let cc = "cell";
      if (myTurn && (mt === "own" || mt === "pair" || mt === "cell") && CW.validCell(g, mode, r, c, swapSel)) cc += " tgt";
      if (myTurn && mt === "row" && rowSel === null && CW.validCell(g, mode, r, c)) cc += " tgt";
      if (myTurn && mt === "side" && insertSide(g, r, c)) cc += " tgt edgeglow";
      if (swapSel && swapSel[0] === r && swapSel[1] === c) cc += " sel";
      const wi = wins.get(r + "," + c);
      if (wi !== undefined) cc += " win";
      let disc = "", disc0 = "";
      const at = (rr, cc2) => rr === r && cc2 === c;
      if (v) {
        let n = 0, extra = "", style = "", vShow = v;
        const dfx = fxFind("drop", f => at(f.r, f.c));
        if (dfx) { n = gup ? ROWS - r : r + 1; style += dfx.ad; }
        if (flip && flip.phase === 2 && (flip.type === "rotate" || flip.type === "shift" || flip.type === "insert")) n = flip.settle[r + "," + c] || 0;
        if (flip && flip.phase === 1 && flip.type === "insert" && r === flip.ev_r && c === flip.ev_c) {
          const fromC = flip.dir === "left" ? -1 : COLS;
          extra += " slide"; style += `--sx:calc(${fromC - c} * (116.3% + 7px));--sy:0px;`;
        }
        // The piece it knocked back slides one cell, starting as the inserted disc arrives.
        if (flip && flip.phase === 1 && flip.type === "insert" && flip.knock && r === flip.ev_r && c === flip.knock.to) {
          extra += " slide knocked"; style += `--sx:calc(${flip.knock.from - c} * (116.3% + 7px));--sy:0px;`;
        }
        else if (flip && flip.phase === 2 && flip.type === "gravity" && flip.settle) n = flip.settle[r + "," + c] || 0;
        else if (flip && flip.phase === 2 && (flip.type === "gravity" || (flip.type !== "clear" && flip.c === c))) n = flip.type === "pop" ? 1 : ROWS - CW.count(g, c);
        if (flip && flip.phase === 2 && flip.type === "clear") n = clearedFall(flip, r, c, gup);
        if (flip && flip.phase === 1 && flip.type === "clear" && flip.ev && flip.ev.type === "drop" && at(flip.ev.r, flip.ev.c)) n = gup ? ROWS - r : r + 1;
        if (flip && flip.phase === 1 && flip.type === "clear" && cleared.has(r + "," + c)) { extra += flip.ev && flip.ev.type === "boom" ? " boomed" : " scored"; style += `--wd:${(0.25 + cleared.get(r + "," + c) * 0.06).toFixed(2)}s;`; }
        if (v === 5 && !vShowPending(r + "," + c)) n = 0; // fixed stones never move (a just-dropped disc that is about to petrify still falls)
        if (n) { const [k, st] = motion(n); extra += k; style += st; }
        const popFloor = (flip && flip.prev && flip.prev.gdir === -1) || (!flip && gup) ? 0 : ROWS - 1;
        if (flip && flip.phase === 1 && flip.type === "pop" && flip.c === c && r === popFloor) extra += " burst";
        const key = r + "," + c;
        const pfx = fxFind("score", f => (f.petrify || []).includes(key)) || fxFind("contest", f => (f.petrify || []).includes(key));
        if (pfx && pfx.owner && pfx.start > fxNow()) vShow = CW.PV(pfx.owner[key]); // still the player's disc until the move lands
        else if (pfx) { extra += " petrify"; style += pfx.ad; }
        const rfx = fxFind("reinforce", f => f.c === c && (f.gdir === -1 ? r < f.n : r >= ROWS - f.n));
        if (rfx) { extra += " push"; style += rfx.ad + `--push:calc(${rfx.gdir === -1 ? -1 : 1} * (116.3% + 3px));`; }
        const pufx = fxFind("punch", f => at(f.r, f.c));
        if (pufx) {
          const fallN = Math.abs(pufx.r - pufx.from);
          if (fallN) { const [k, st] = motion(fallN); extra += k; style += st + pufx.ad; } else { extra += " punchin"; style += pufx.ad; }
          disc0 = `<div class="shock own${pufx.by || ""}" style="${pufx.ad}"></div>`;
        }
        if (flip && flip.phase === 1 && flip.type === "shift" && r === flip.r && v !== 5) {
          const nonFixed = []; for (let cc = 0; cc < COLS; cc++) if (flip.prev.grid[r][cc] !== 5) nonFixed.push(cc);
          const i = nonFixed.indexOf(c), fromC = flip.dir === "right" ? nonFixed[(i - 1 + nonFixed.length) % nonFixed.length] : nonFixed[(i + 1) % nonFixed.length];
          extra += " slide"; style += `--sx:calc(${fromC - c} * (116.3% + 7px));--sy:0px;`;
        }
        const afx = fxFind("anchor", f => at(f.r, f.c));
        if (afx) { extra += " anc-in"; style += afx.ad; }
        const sfx = fxFind("swap", f => at(f.r, f.c) || at(f.r2, f.c2));
        if (sfx) {
          const from = at(sfx.r, sfx.c) ? [sfx.r2, sfx.c2] : [sfx.r, sfx.c];
          extra += " slide"; style += sfx.ad + `--sx:calc(${from[1] - c} * (116.3% + 7px));--sy:calc(${from[0] - r} * (116.3% + 3px));`;
        }
        if (pend && pend.has(r + "," + c) && !(flip && flip.phase === 1)) extra += " pend";
        const lst = g.last && g.last.r === r && g.last.c === c && !g.over;
        if (v === 4) { const b = (g0.bombs || []).find(x => x.id === shown.anc[r][c]); if (b && b.until - now < 900) extra += " fuse-hot"; if (b && b.by) extra += " own" + b.by; }
        if (v === 3 && typeof shown.anc[r][c] === "string" && shown.anc[r][c][0] === "o") extra += " own" + shown.anc[r][c].slice(1);
        disc = `<div class="disc d${vShow} ${shown.anc[r][c] === true ? "anc" : ""}${extra} ${lst ? "last" : ""}" ${style ? `style="${style}"` : ""}></div>` + disc0;
      } else {
        const lfx = fxFind("lift", f => at(f.r, f.c));
        if (lfx) disc = `<div class="disc d${lfx.v} lift-out${gup ? " down" : ""}" style="${lfx.ad}"></div>`;
      }
      if (flip && flip.phase === 1 && flip.ev && flip.ev.type === "boom" && at(flip.ev.r, flip.ev.c)) disc += `<div class="blast own${flip.ev.by || ""}"></div>`;
      const shf = fxFind("drop", f => f.broke != null && at(f.broke, f.c));
      if (shf) disc += `<div class="disc d5 shatter" style="${shf.ad}"></div>`;
      if (flip && flip.phase === 1 && flip.type === "insert" && flip.broke != null && at(flip.r, flip.broke)) disc += `<div class="disc d5 shatter"></div>`;
      const wd = wi !== undefined ? `style="--wd:${(0.3 + wi * 0.15).toFixed(2)}s"` : "";
      cells += `<div class="${cc}" data-r="${r}" data-c="${c}" ${wd}>${disc}</div>`;
    }
    cols += `<div class="${cls}" style="grid-template-rows:repeat(${ROWS},auto);${colStyle}" role="button" aria-label="Column ${L[c]}">${cells}</div>`;
  }
  const dd = fxFind("double");
  // Board class + inline style (column count, and a resumed Double Drop flash).
  // If anyone can Rotate, the board lives in a fixed square frame sized for its longer side, so turning
  // 8×7 into 7×8 keeps the same cell size and the page never resizes.
  const rotGame = [V.myPicks, V.oppPicks, ...(V.allPicks ? Object.values(V.allPicks) : [])].some(pk => pk && pk.includes("rotate"));
  const M = Math.max(ROWS, COLS);
  const fit = rotGame ? `width:calc(${COLS} / ${M} * 100%);margin-inline:auto;` : "";
  const ddFlash = `${dd ? "dd-flash" : ""}" style="grid-template-columns:repeat(${COLS},1fr);${fit}${dd ? dd.ad : ""}`;
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
  <div class="players" style="grid-template-columns:repeat(${V.n || 2},1fr)">${turnOrder().map(panel).join("")}</div>
  <p class="status" aria-live="polite">${statusText()}</p>
  <div class="board-wrap ${rotGame ? "square" : ""}"><div class="board ${!rt && showWin && g.result ? "won" : ""} ${gravCls()} ${flip && flip.phase === 1 && flip.type === "rotate" ? "rot-" + flip.dir : ""} ${g.gdir === -1 ? "up" : ""} ${ddFlash}">${cols}</div>${pend ? `<div class="contest">Contested!</div>` : ""}${fxFind("contest") ? `<div class="contest cancel">Contested! Cancelled</div>` : ""}${myTurn ? dirOverlay(g) : ""}${g.over && showOver ? overHtml() : ""}</div>${bannerHtml()}
  <div class="letters" style="grid-template-columns:repeat(${COLS},1fr);${fit}">${[...L].map(x => `<span>${x}</span>`).join("")}</div>
  ${g.gdir === -1 ? `<div class="gravtag">Gravity is up: discs rise from the bottom${g.gravRevert ? ` · flips back at the start of ${g.gravRevert.by === V.seat ? "your" : you(g.gravRevert.by) + "'s"} ${["", "next", "2nd", "3rd"][g.gravRevert.left] || ""} turn` : ""}</div>` : ""}
  ${myTurn ? choiceHtml(g) : ""}
  ${tray}
  <p class="err">${err}</p>
  ${rt ? `<details><summary>Rules</summary><ul>
    <li>No turns. You hold up to 3 drop charges; one recharges every 2.5s. Each ability has its own cooldown. Any action also starts a 0.15s global cooldown.</li>
    <li>Each four scores 1 point, and its discs turn into fixed stones. Fixed stones never move (not even with Gravity Flip). A grenade destroys them, and a drop smashes the first fixed stone it lands on and keeps falling.</li>
    <li>Contested: after a four, your opponent has 0.5s to make their own four. If they do, neither scores and both fours turn to stone.</li>
    <li>First to 5 wins. After 5 minutes the higher score wins. A tie goes to sudden death: cooldowns ×¼, next score wins.</li>
    <li>Round dark hatched stone = Block (neutral, falls with gravity). Light gray square = scored four (fixed in place).</li>
    <li>A full board with no four is wiped.</li></ul></details>` : `<details><summary>Rules</summary><ul>
    <li>Each four in a row scores a point and turns into fixed stones. First to ${CW.TARGET} fours wins.</li>
    <li>A drop smashes the first fixed stone it lands on and keeps falling. A full board is wiped.</li>
    <li>Using a Grenade or Insert ends your turn.</li>
    <li>Each turn: gain 1 energy (max 7), optionally use one ability, then drop one disc.</li>
    <li>Gold ring = anchored disc (immune to Pop and Swap). Striped column = frozen for one player.</li>
    <li>If one move gives two players their winning four, the player who moved wins.</li>
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
  ${choiceHtml({ ...g0, cur: modeSeat })}
  <p class="status tabletop-status" aria-live="polite">${status}${g0.gdir === -1 ? ` <span class="gravtag inline">Gravity up</span>` : ""}</p>
  <div class="board-wrap"><div class="board ${gravCls()} ${g0.gdir === -1 ? "up" : ""} ${ddFlash}">${cols}</div>${pend ? `<div class="contest">Contested!</div>` : ""}${fxFind("contest") ? `<div class="contest cancel">Contested! Cancelled</div>` : ""}${!g0.over && !busy ? dirOverlay({ ...g0, cur: modeSeat }) : ""}${g0.over && showOver ? overHtml() : ""}</div>${bannerHtml()}
  ${side(1)}
  ${g0.over ? `<button class="ghost" data-act="leave">Leave game</button>` : ""}`;
}

/* ================= input ================= */
function sendAct(type, p) {
  if (type === "ability") rowSel = null;
  if (V && V.local && isRT() && type === "ability" && p.__seat == null) p.__seat = modeSeat;
  if (type === "ability") { mode = null; swapSel = null; }
  act(type, p, res => { if (res && res.error) { localMsg = res.error; mode = null; swapSel = null; render(); } });
}

app.addEventListener("submit", e => {
  if (e.target.id === "nameForm") {
    e.preventDefault();
    const n = cleanName(document.getElementById("nameIn").value);
    if (!n) { err = "Enter a name."; return render(); }
    myName = n; store("cw_name", n); err = ""; homeScreen = "home"; return render();
  }
  if (e.target.id === "hostForm") {
    e.preventDefault();
    const ln = String(document.getElementById("lobbyIn").value || "").replace(/\s+/g, " ").trim().slice(0, 28);
    homeScreen = "home"; err = "";
    return createGame(null, { lobbyName: ln || `${myName}'s Lobby` });
  }
  if (e.target.id !== "joinForm") return;
  e.preventDefault();
  const c = document.getElementById("code").value.trim().toUpperCase();
  if (c.length !== 4) { err = "Enter the 4-character game code."; return render(); }
  joinGame(c);
});
app.addEventListener("change", e => { if (e.target.id === "timerOn") timerOn = e.target.checked; });

app.addEventListener("click", e => {
  const pc = e.target.closest("[data-players]");
  if (pc) { playerCount = +pc.dataset.players; return render(); }
  const lb = e.target.closest("[data-joinlobby]");
  if (lb) { const c = lb.dataset.joinlobby; stopBrowsing(); homeScreen = "home"; err = ""; return joinGame(c); }
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
    if (a === "matchmake") { return startMatchmaking(); }
    if (a === "rename") { homeScreen = "name"; err = ""; return render(); }
    if (a === "home") { homeScreen = "home"; err = ""; stopBrowsing(); return render(); }
    if (a === "hostform") { homeScreen = "host"; err = ""; return render(); }
    if (a === "browse") { homeScreen = "browse"; err = ""; startBrowsing(); return render(); }
    if (a === "refresh-lobbies") { fetchLobbies(); return; }
    if (a === "mm-cancel") { stopMatchmaking(); return render(); }
    if (a === "menu") { confirmMenu = true; return app.insertAdjacentHTML("beforeend", menuModal()); }
    if (a === "menu-no") { confirmMenu = false; const m = app.querySelector(".modal"); if (m) m.remove(); return; }
    if (a === "menu-yes") { confirmMenu = false; err = ""; return leave(); }
    if (a === "rejoin") { err = ""; return joinGame(store("cw_room")); }
    if (a === "reset") { hardReset(); err = "Saved games cleared."; return render(); }
    if (a === "p2ready") { localHandoff = false; localSeat += 1; sel = []; return publish(); }
    if (a === "copy") {
      const txt = document.getElementById("link").textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => { actEl.textContent = "Copied"; }).catch(() => {});
      return;
    }
    if (a === "lock") {
      const more = isLocal && room && localSeat < roomN();
      sendAct("pick", { ids: sel });
      if (more && room.phase === "draft") { localHandoff = true; render(); }
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
    mode = id; swapSel = null; rowSel = null; return render();
  }
  const dirBtn = e.target.closest("[data-dir]");
  if (dirBtn && (mode === "rotate" || ((mode === "shift" || mode === "insert") && rowSel !== null))) {
    const dir = dirBtn.dataset.dir, payload = mode === "rotate" ? { id: "rotate", dir } : { id: mode, r: rowSel, dir };
    rowSel = null; return sendAct("ability", payload);
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
  if (mode === "insert") {
    const side = insertSide(g, r, c);
    if (!side) { localMsg = "Tap a glowing slot on the left or right edge."; return render(); }
    return sendAct("ability", { id: "insert", r, dir: side });
  }
  if (mode === "shift") {
    if (!CW.validCell(g, mode, r, c)) { localMsg = "That row has nothing to shift."; return render(); }
    rowSel = rowSel === r ? null : r; return render();
  }
  if (mode === "rotate") return;
  if (mode === "punch") {
    if (!CW.validCell(g, "punch", r, c)) { localMsg = "Punch In can't target an enemy disc or your own disc."; return render(); }
    return sendAct("ability", { id: "punch", r, c });
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
// Reload into version v once; if we already tried and still got the old page, don't loop.
function tryReload(v) {
  let tried = null; try { tried = sessionStorage.getItem("cw_reload_for"); } catch (e) {}
  if (tried === v) return false;
  try { sessionStorage.setItem("cw_reload_for", v); } catch (e) {}
  location.replace(location.pathname + "?v=" + v + location.hash);
  return true;
}
// Check for a newer build. On the main menu, reload straight into it; mid-game, show a notice.
async function checkVersion() {
  if (APP_VERSION === "dev") return;
  try {
    const res = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    const v = (await res.json()).version;
    if (!v || v === APP_VERSION) return;
    const idle = !V && !mm && !code && !isLocal;
    if (idle && tryReload(v)) return;
    if (updateReady !== v) { updateReady = v; render(); }
  } catch (e) {}
}
setInterval(checkVersion, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });

(function boot() {
  checkVersion();
  dirOpen();
  const fromHash = location.hash.replace("#", "").trim().toUpperCase();
  if (fromHash === "RESET") { hardReset(); return render(); }
  if (!sb) return render();
  // Only a link with a code joins automatically. A remembered game shows a Rejoin button instead.
  if (fromHash.length === 4) joinGame(fromHash); else render();
})();
