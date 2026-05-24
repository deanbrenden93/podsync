/**
 * PodSync web — main app.
 *
 * Mirrors the desktop's PodSyncAPI + index.html glue, but entirely
 * client-side. Everything that was a py(...) call in the desktop build
 * is a direct call into one of our module objects:
 *
 *   desktop                   web
 *   -------------------       -------------------
 *   py('get_config')       -> config
 *   py('create_account')   -> library.registerProfile + library.getUsage
 *   py('create_room')      -> relay.connectAsHost + recorder.arm
 *   py('start_recording')  -> library.registerSession + relay.sendStart
 *   py('stop_recording')   -> recorder.stop + library.uploadBlob
 *   py('list_sessions')    -> library.listHostSessions + getUsage
 */

import { Recorder, listInputDevices } from './recorder.js';
import { RelayConnection } from './relay.js';
import { LibraryClient, DEFAULT_LIBRARY_BASE } from './library.js';
import { loadConfig, saveConfig, clearConfig } from './config.js';

let config = loadConfig();
const library = new LibraryClient(config.library_base);

let recorder = null;
let relay = null;
let isRecording = false;
let currentScreen = 'loading';
let currentParticipantNames = [];
let currentSessionId = '';
let lastRecordingBlob = null;
let lastRecordingName = '';
let lastRecordingUploaded = false;
let timerInterval = null;
let timerStart = 0;

// Test-audio scratchpad.
let testRecorder = null;
let testBlob = null;
let testTimerInterval = null;

// Session name that the host broadcasts when a recording starts. We
// stash it so guest uploads can be archived locally with a human-
// readable label (see loadGuestSessions / addGuestSession below).
let currentSessionName = '';

// AbortControllers for the three list screens. Each loadXxx() call
// aborts the previous one so a stalled fetch can't pin the "Loading…"
// state when the user navigates back in.
let _sessionsCtl = null;
let _adminUsersCtl = null;
let _adminSessionsCtl = null;

// ── Helpers ──
const $ = (id) => document.getElementById(id);

function goTo(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = $('screen-' + screen);
  if (!target) return;
  target.classList.add('active');
  currentScreen = screen;

  if (screen === 'home') {
    const name = config.display_name || config.username || '';
    $('home-welcome').textContent = name ? `Welcome back, ${name}` : '';
    updateAdminVisibility();
  }
  if (screen === 'sessions') loadSessions();
  if (screen === 'test')     populateTestDevices();
  if (screen === 'settings') populateSettings();
  if (screen === 'host')     resetHostScreen();
  if (screen === 'guest')    resetGuestScreen();
  if (screen === 'admin')    resetAdminScreen();
  if (screen === 'login') {
    $('login-status').textContent = '';
    $('login-password').value = '';
  }
  if (screen === 'signup') {
    $('signup-status').textContent = '';
  }
}

function updateAdminVisibility() {
  const has = !!(config.admin_token && config.admin_token.trim());
  $('home-admin-row').classList.toggle('hidden', !has);
}

function showStatus(id, msg, type = 'info') {
  const el = $(id + '-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status status-' + type;
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function copyText(id) {
  const text = $(id).textContent.trim();
  navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
}

// ── Guest session history ──
// The server's /library/list?mode=host endpoint only returns sessions
// the user OWNS. Sessions where the user was a guest (e.g. someone
// else's podcast) never show up there, so the Sessions screen used to
// go blank for pure-guest users even after a successful upload. We
// record each guest upload locally so those users can still see,
// re-download, and clean up their own recordings.
const GUEST_SESSIONS_KEY = 'podsync.guest_sessions.v1';

function loadGuestSessions() {
  try {
    const raw = localStorage.getItem(GUEST_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveGuestSessions(list) {
  try { localStorage.setItem(GUEST_SESSIONS_KEY, JSON.stringify(list)); } catch {}
}

function addGuestSession(entry) {
  if (!entry || !entry.session_id || !entry.host || !entry.user) return;
  const list = loadGuestSessions();
  const key = (s) => `${(s.host || '').toUpperCase()}::${s.session_id}::${(s.user || '').toUpperCase()}`;
  const idx = list.findIndex(s => key(s) === key(entry));
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.unshift(entry);
  saveGuestSessions(list);
}

function removeGuestSession(sessionId, host, user) {
  const me = (user || '').toUpperCase();
  const h = (host || '').toUpperCase();
  const list = loadGuestSessions().filter(
    s => !(s.session_id === sessionId
           && (s.host || '').toUpperCase() === h
           && (s.user || '').toUpperCase() === me)
  );
  saveGuestSessions(list);
}

// ── Delegated click routing for data-goto / data-copy ──
document.addEventListener('click', (ev) => {
  const gotoEl = ev.target.closest('[data-goto]');
  if (gotoEl) {
    ev.preventDefault();
    goTo(gotoEl.dataset.goto);
    return;
  }
  const copyEl = ev.target.closest('[data-copy]');
  if (copyEl) {
    ev.preventDefault();
    copyText(copyEl.dataset.copy);
  }
});

// ── Signup ──
$('signup-btn').addEventListener('click', async () => {
  const display = $('signup-display').value.trim();
  const username = $('signup-username').value.trim().toUpperCase();
  const email    = $('signup-email').value.trim();
  const pw       = $('signup-password').value;
  const pw2      = $('signup-password2').value;

  if (!display)  return showStatus('signup', 'Please enter your display name.', 'error');
  if (!username || username.length < 3) return showStatus('signup', 'Username must be at least 3 characters.', 'error');
  if (!/^[A-Z0-9_-]+$/.test(username))  return showStatus('signup', 'Username can only contain letters, numbers, dashes, and underscores.', 'error');
  if (!email.includes('@') || !email.includes('.')) return showStatus('signup', 'Please enter a valid email address.', 'error');
  if (pw.length < 4) return showStatus('signup', 'Password must be at least 4 characters.', 'error');
  if (pw !== pw2)    return showStatus('signup', 'Passwords do not match.', 'error');

  showStatus('signup', 'Creating account…', 'info');
  $('signup-btn').disabled = true;
  try {
    // Same pattern as the desktop: first hit /library/usage to set the
    // server-side password on first access. A 200 means success; 403
    // means the username is taken by someone else.
    const usage = await library.getUsage(username, pw);
    if (!usage.ok) {
      showStatus('signup', usage.error || 'Could not create account.', 'error');
      return;
    }
    await library.registerProfile(username, pw, display, email);
    config = { ...config,
      display_name: display,
      username,
      email,
      library_password: pw,
      is_setup: true,
    };
    saveConfig(config);
    goTo('home');
  } finally {
    $('signup-btn').disabled = false;
  }
});

// ── Login ──
$('login-btn').addEventListener('click', async () => {
  const username = $('login-username').value.trim().toUpperCase();
  const pw = $('login-password').value;
  if (!username) return showStatus('login', 'Enter your username.', 'error');
  if (!pw)       return showStatus('login', 'Enter your password.', 'error');

  showStatus('login', 'Signing in…', 'info');
  $('login-btn').disabled = true;
  try {
    const usage = await library.getUsage(username, pw);
    if (!usage.ok) {
      let err = usage.error || 'Invalid username or password.';
      if (/password|invalid/i.test(err)) err = 'Invalid username or password.';
      showStatus('login', err, 'error');
      return;
    }
    config = { ...config,
      username,
      library_password: pw,
      display_name: config.display_name || username,
      is_setup: true,
    };
    saveConfig(config);
    goTo('home');
  } finally {
    $('login-btn').disabled = false;
  }
});

// ── Host flow ──
$('host-back').addEventListener('click', async () => {
  await leaveSession();
  goTo('home');
});

let _createBusy = false;
$('host-create-btn').addEventListener('click', async () => {
  if (_createBusy) return;
  _createBusy = true;
  const btn = $('host-create-btn');
  btn.disabled = true;
  showStatus('host-pre', 'Connecting…', 'info');
  try {
    await createRoom();
  } catch (e) {
    showStatus('host-pre', 'Error: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
    _createBusy = false;
  }
});

async function createRoom() {
  // 1. Ask for mic permission & build the recorder.
  recorder = new Recorder();
  recorder.onLevel = (v) => setLocalLevel(v);
  recorder.onDisconnect = (reason) => showStatus('host', 'Mic disconnected: ' + reason, 'warning');

  try {
    await recorder.arm(config.input_device || null);
  } catch (e) {
    showStatus('host-pre', micErrorMessage(e), 'error');
    recorder = null;
    if (isPermissionBlocked(e)) showMicBlockedModal(createRoom);
    else if (isEmbeddedBrowserError(e)) showBrowserWarn();
    return;
  }

  // 2. Connect to relay as host.
  relay = new RelayConnection(config.relay_url);
  wireHostRelay(relay);
  const { room, pin } = relay.connectAsHost(config.username);

  $('host-room-code').textContent = room;
  $('host-pin').textContent = pin;
  $('host-pre').classList.add('hidden');
  $('host-room').classList.remove('hidden');
  showStatus('host', 'Room created. Waiting for participants…', 'success');

  const sessionName = $('host-session-name').value.trim();
  if (sessionName) relay.sendSessionName(sessionName);
}

function wireHostRelay(r) {
  r.onConnected = () => r.sendReady();
  r.onParticipants = (users) => renderParticipants('host', users);
  r.onPrepare = async (_t, sessionName, sessionId) => {
    currentSessionId = sessionId;
    await recorder.start();
    isRecording = true;
    startTimer('host');
    $('host-record-area').classList.add('hidden');
    $('host-stop-area').classList.remove('hidden');
    $('host-timer').classList.remove('hidden');
    showStatus('host', 'Recording…', 'success');
  };
  r.onStop = () => { if (isRecording) doStopRecording('host'); };
  r.onSyncTone = () => {
    recorder?.injectTone();
    if (config.username) r.sendSyncToneAck(config.username);
    pulseChip(config.username);
  };
  r.onSyncToneAck = (name) => pulseChip(name);
  r.onPeerLevel = (name, level) => setPeerLevel(name, level);
  r.onError = (msg) => showStatus('host', msg, 'error');
  r.onDisconnected = () => {
    if (isRecording) {
      doStopRecording('host');
      showStatus('host', 'Connection lost. Recording saved.', 'warning');
    }
  };
}

$('host-copy-both').addEventListener('click', () => {
  const room = $('host-room-code').textContent.trim();
  const pin = $('host-pin').textContent.trim();
  navigator.clipboard.writeText(`Room: ${room}\nPIN: ${pin}`).then(() => showToast('Copied both!'));
});

$('host-record-btn').addEventListener('click', async () => {
  const sessionName = $('host-session-name').value.trim();
  const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  currentSessionId = sessionId;
  currentSessionName = sessionName;
  config.last_session_id = sessionId;
  config.last_session_room = relay.roomCode;
  config.last_session_pin = relay.pin;
  config.last_session_host = config.username;
  saveConfig(config);

  const participants = [config.username, ...currentParticipantNames.filter(n => n && n.toUpperCase() !== config.username.toUpperCase())];

  // Best-effort register session on the server BEFORE telling peers
  // to start, so guest uploads are authorized when they arrive.
  if (config.library_password) {
    try {
      await library.registerSession({
        username: config.username,
        password: config.library_password,
        session_id: sessionId,
        session_name: sessionName,
        room: relay.roomCode,
        pin: relay.pin,
        participants,
      });
    } catch (e) { /* non-fatal */ }
  }

  relay.sendStart(sessionName, sessionId);
});

$('host-stop-btn').addEventListener('click', () => doStopRecording('host'));
$('host-sync-btn').addEventListener('click', () => {
  if (!relay) return;
  // Immediate visual acknowledgement of the click. The chip pulse
  // that ALSO fires comes from the relay echoing sync_tone back to us
  // via r.onSyncTone -> pulseChip(config.username). If the echo is
  // slow or lost, the button state alone tells the user "yes, sent".
  const btn = $('host-sync-btn');
  const orig = btn.textContent;
  btn.classList.add('sync-sent');
  btn.textContent = '✓ Sync Tone Sent';
  setTimeout(() => {
    btn.classList.remove('sync-sent');
    btn.textContent = orig;
  }, 700);
  relay.sendSyncTone();
});

$('host-dl-btn').addEventListener('click', () => {
  if (lastRecordingBlob) triggerDownload(lastRecordingBlob, lastRecordingName);
});

// ── Guest flow ──
$('guest-back').addEventListener('click', async () => {
  await leaveSession();
  goTo('home');
});

let _joinBusy = false;
$('guest-connect-btn').addEventListener('click', async () => {
  if (_joinBusy) return;
  const room = $('guest-room').value.trim().toUpperCase();
  const pin = $('guest-pin').value.trim();
  if (!room || !pin) return showStatus('guest-pre', 'Enter room code and PIN', 'warning');
  _joinBusy = true;
  const btn = $('guest-connect-btn');
  btn.disabled = true;
  showStatus('guest-pre', 'Connecting…', 'info');
  try {
    await joinRoom(room, pin);
  } catch (e) {
    showStatus('guest-pre', 'Error: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
    _joinBusy = false;
  }
});

async function joinRoom(room, pin) {
  recorder = new Recorder();
  recorder.onLevel = (v) => setLocalLevel(v);
  recorder.onDisconnect = (reason) => showStatus('guest', 'Mic disconnected: ' + reason, 'warning');
  try {
    await recorder.arm(config.input_device || null);
  } catch (e) {
    showStatus('guest-pre', micErrorMessage(e), 'error');
    recorder = null;
    if (isPermissionBlocked(e)) showMicBlockedModal(() => joinRoom(room, pin));
    else if (isEmbeddedBrowserError(e)) showBrowserWarn();
    return;
  }

  relay = new RelayConnection(config.relay_url);
  wireGuestRelay(relay);
  relay.connectAsGuest(config.username, room, pin);
}

function wireGuestRelay(r) {
  r.onConnected = (sessionName) => {
    r.sendReady();
    currentSessionName = sessionName || '';
    $('guest-pre').classList.add('hidden');
    $('guest-session').classList.remove('hidden');
    $('guest-session-label').textContent = sessionName ? 'Connected: ' + sessionName : 'Connected to session';
    showStatus('guest', 'Waiting for host to start recording…', 'success');
  };
  r.onDenied = (reason) => {
    showStatus('guest-pre', 'Denied: ' + reason, 'error');
    $('guest-pre').classList.remove('hidden');
    $('guest-session').classList.add('hidden');
  };
  r.onParticipants = (users) => {
    // Remember the host's username so guest uploads know who to
    // register against.
    for (const p of users) {
      if (p.role === 'host') {
        config.last_session_host = p.name;
        config.last_session_room = relay.roomCode;
        config.last_session_pin = relay.pin;
        saveConfig(config);
      }
    }
    renderParticipants('guest', users);
  };
  r.onPrepare = async (_t, sessionName, sessionId) => {
    currentSessionId = sessionId;
    if (sessionName) currentSessionName = sessionName;
    await recorder.start();
    isRecording = true;
    startTimer('guest');
    $('guest-status').textContent = 'Recording…';
    $('guest-status').className = 'status status-success';
    $('guest-timer').classList.remove('hidden');
  };
  r.onStop = () => { if (isRecording) doStopRecording('guest'); };
  r.onSyncTone = () => {
    recorder?.injectTone();
    if (config.username) r.sendSyncToneAck(config.username);
    pulseChip(config.username);
  };
  r.onSyncToneAck = (name) => pulseChip(name);
  r.onPeerLevel = (name, level) => setPeerLevel(name, level);
  r.onHostLeft = () => {
    if (isRecording) {
      doStopRecording('guest');
      showStatus('guest', 'Host disconnected. Recording saved.', 'warning');
    }
  };
  r.onError = (msg) => showStatus('guest', msg, 'error');
  r.onDisconnected = () => {
    if (isRecording) {
      doStopRecording('guest');
      showStatus('guest', 'Connection lost. Recording saved.', 'warning');
    }
  };
}

$('guest-dl-btn').addEventListener('click', () => {
  if (lastRecordingBlob) triggerDownload(lastRecordingBlob, lastRecordingName);
});

// ── Shared recording stop path ──
async function doStopRecording(who) {
  if (!isRecording || !recorder) return;
  isRecording = false;
  stopTimer();

  const blob = await recorder.stop();
  if (who === 'host') {
    relay?.sendStop();
    $('host-stop-area').classList.add('hidden');
    $('host-record-area').classList.remove('hidden');
    $('host-timer').classList.add('hidden');
  } else {
    $('guest-timer').classList.add('hidden');
  }

  if (!blob) {
    showStatus(who, 'No audio captured.', 'warning');
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const sessionName = $('host-session-name')?.value.trim() || '';
  const safeSession = sessionName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const safeUser = config.username.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  const parts = [stamp, safeSession, safeUser].filter(Boolean);
  lastRecordingName = parts.join('_') + '.wav';
  lastRecordingBlob = blob;
  lastRecordingUploaded = false;

  // Immediate local download so the user ALWAYS has a safety-net copy
  // even if the server is unreachable. This matches the desktop app's
  // "two copies always exist" guarantee.
  triggerDownload(blob, lastRecordingName);

  if (who === 'host') {
    $('host-post-actions').classList.remove('hidden');
  } else {
    const g = $('guest-post-actions');
    if (g) g.classList.remove('hidden');
  }

  // Upload to server.
  await uploadRecording(who, blob);
}

async function uploadRecording(who, blob) {
  if (!config.library_password || !currentSessionId || !relay) {
    showStatus(who, 'Saved locally. Not uploaded (no session context).', 'warning');
    return;
  }

  const hostUser = config.last_session_host || config.username;
  const bar = $(who + '-upload-bar');
  const fill = $(who + '-upload-fill');
  bar?.classList.remove('hidden');
  showStatus(who, `Uploading ${(blob.size / 1048576).toFixed(1)} MB…`, 'info');

  const result = await library.uploadBlob({
    hostUser,
    sessionId: currentSessionId,
    guestUser: config.username,
    room: relay.roomCode,
    pin: relay.pin,
    blob,
    onProgress: (sent, total) => {
      if (fill && total) {
        const pct = Math.round(sent / total * 100);
        fill.style.width = pct + '%';
      }
    },
  });

  if (result.ok) {
    lastRecordingUploaded = true;
    showStatus(who, 'Uploaded.', 'success');
    // Pure-guest users would otherwise never see this recording again
    // (mode=host listing only covers sessions they OWN). Cache enough
    // to render + re-download from the Sessions screen.
    if (who === 'guest') {
      addGuestSession({
        session_id: currentSessionId,
        session_name: currentSessionName || '',
        host: hostUser,
        user: config.username,
        room: relay.roomCode,
        pin: relay.pin,
        file_size: blob.size,
        created_at: Date.now(),
      });
    }
  } else {
    showStatus(who, 'Upload failed: ' + result.error + ' (local copy is safe)', 'error');
  }
  setTimeout(() => bar?.classList.add('hidden'), 1500);
}

async function leaveSession() {
  stopTimer();
  isRecording = false;
  try { await recorder?.shutdown(); } catch {}
  try { relay?.disconnect(); } catch {}
  recorder = null;
  relay = null;
}

// ── Timer / meters / chips ──
function startTimer(who) {
  timerStart = Date.now();
  const el = $(who + '-timer');
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    el.textContent = formatTime((Date.now() - timerStart) / 1000);
  }, 250);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

function setLocalLevel(v) {
  const pct = Math.min(100, v * 100) + '%';
  if (currentScreen === 'host') $('host-level').style.width = pct;
  if (currentScreen === 'guest') $('guest-level').style.width = pct;
  if (currentScreen === 'test')  $('test-level').style.width = pct;
  if (relay && config.username) setPeerLevel(config.username, v);

  // Throttled relay broadcast so other clients see our chip animate.
  if (relay && !setLocalLevel._last) setLocalLevel._last = 0;
  const now = performance.now();
  if (relay && now - (setLocalLevel._last || 0) > 120) {
    setLocalLevel._last = now;
    try { relay.sendLevel(v); } catch {}
  }
}

let chipElements = {};
let chipFadeTimers = {};
const SPEAKING_THRESHOLD = 0.05;

function renderParticipants(who, users) {
  const container = $(who + '-participants');
  if (!container) return;
  container.classList.add('participants-list');
  container.innerHTML = '';
  chipElements = {};
  for (const t of Object.values(chipFadeTimers)) clearTimeout(t);
  chipFadeTimers = {};
  let readyCount = 0;
  currentParticipantNames = [];
  for (const p of users) {
    const chip = document.createElement('div');
    chip.className = 'participant-chip';
    if (p.ready) chip.classList.add('ready');
    if (p.name && config.username && p.name.toUpperCase() === config.username.toUpperCase()) {
      chip.classList.add('you');
    }
    chip.innerHTML = `<span class="chip-dot"></span><span class="chip-name">${escapeHtml(p.name)}</span>${p.role === 'host' ? '<span class="chip-role">host</span>' : ''}`;
    container.appendChild(chip);
    if (p.name) {
      chipElements[p.name.toLowerCase()] = chip;
      currentParticipantNames.push(p.name);
    }
    if (p.ready) readyCount++;
  }
  if (who === 'host') {
    const status = $('host-ready-status');
    const total = users.length;
    status.textContent = readyCount === total
      ? `${total} connected · all ready to record`
      : `${total} connected · ${readyCount} of ${total} ready to record`;
  }
}

function setPeerLevel(name, level) {
  const chip = chipElements[String(name).toLowerCase()];
  if (!chip) return;
  const v = Math.max(0, Math.min(1, level));
  const cur = parseFloat(chip.style.getPropertyValue('--chip-glow')) || 0;
  const eased = cur + (v - cur) * 0.55;
  chip.style.setProperty('--chip-glow', eased.toFixed(3));
  if (v >= SPEAKING_THRESHOLD) {
    chip.classList.add('speaking');
    clearTimeout(chipFadeTimers[name]);
    chipFadeTimers[name] = setTimeout(() => {
      chip.classList.remove('speaking');
      chip.style.setProperty('--chip-glow', '0');
    }, 350);
  }
}

function pulseChip(name) {
  const chip = chipElements[String(name).toLowerCase()];
  if (!chip) return;
  // Restart the CSS animation by removing + re-adding the class on
  // the next frame. Without this trick, subsequent sync tones within
  // the animation window silently get no pulse.
  chip.classList.remove('sync-pulse');
  void chip.offsetWidth; // force reflow
  chip.classList.add('sync-pulse');
  clearTimeout(chipFadeTimers[name]);
  chipFadeTimers[name] = setTimeout(() => {
    chip.classList.remove('sync-pulse');
  }, 800);
}

// ── Downloads ──
function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// ── Sessions screen ──
$('sessions-refresh').addEventListener('click', loadSessions);

async function loadSessions() {
  // Cancel any in-flight fetch so a stalled previous call can't pin
  // us on "Loading…". Without this, leaving and re-entering the
  // screen used to stack requests while the first one hung forever.
  try { _sessionsCtl?.abort(); } catch {}
  const ctl = new AbortController();
  _sessionsCtl = ctl;

  showStatus('sessions', 'Loading…', 'info');
  $('sessions-list').innerHTML = '';
  if (!config.username || !config.library_password) {
    showStatus('sessions', 'Set username and password first.', 'warning');
    return;
  }
  const result = await library.listHostSessions(config.username, config.library_password, { signal: ctl.signal });
  if (ctl.signal.aborted || _sessionsCtl !== ctl) return;
  const usage = await library.getUsage(config.username, config.library_password, { signal: ctl.signal });
  if (ctl.signal.aborted || _sessionsCtl !== ctl) return;
  if (usage.ok) {
    const u = usage.usage;
    const mb = (u.total_bytes / 1048576).toFixed(0);
    const capMb = (u.storage_cap_bytes / 1048576).toFixed(0);
    const pct = ((u.total_bytes / u.storage_cap_bytes) * 100).toFixed(1);
    $('sessions-usage').textContent =
      `Storage: ${mb} MB / ${capMb} MB (${pct}%)  |  Writes: ${u.class_a_ops?.toLocaleString?.() ?? '–'}  |  Reads: ${u.class_b_ops?.toLocaleString?.() ?? '–'}  [${u.month ?? ''}]`;
  }

  const me = (config.username || '').toUpperCase();
  const hostSessions = result.ok ? (result.sessions || []) : [];
  const hostSessionIds = new Set(hostSessions.map(s => s.session_id));
  // Filter locally-cached guest sessions down to the current user and
  // drop any that collide with host-owned sessions to avoid dupes.
  const guestSessions = loadGuestSessions().filter(
    s => (s.user || '').toUpperCase() === me && !hostSessionIds.has(s.session_id)
  );

  if (!result.ok) {
    if (guestSessions.length === 0) {
      showStatus('sessions', 'Error: ' + result.error, 'error');
      return;
    }
    // Partial success: surface the error but still show guest sessions
    // the user already uploaded on this browser.
    showStatus('sessions', `${guestSessions.length} guest session(s) shown · host list failed: ${result.error}`, 'warning');
  } else if (hostSessions.length === 0 && guestSessions.length === 0) {
    showStatus('sessions', 'No sessions yet. Record something first!', 'info');
    return;
  } else {
    const parts = [];
    if (hostSessions.length) parts.push(`${hostSessions.length} hosted`);
    if (guestSessions.length) parts.push(`${guestSessions.length} joined as guest`);
    showStatus('sessions', parts.join(' · '), 'success');
  }

  for (const s of hostSessions) {
    const files = s.files || {};
    const fileCount = Object.keys(files).length;
    const totalMb = Object.values(files).reduce((sum, f) => sum + (f.size || 0), 0) / 1048576;
    const date = s.created_at ? new Date(s.created_at).toLocaleString() : '';
    const filesHtml = Object.entries(files)
      .map(([user, f]) => `<div class="session-file">${escapeHtml(user)} (${(f.size / 1048576).toFixed(1)} MB)</div>`)
      .join('');

    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-name">${escapeHtml(s.session_name || 'Untitled')}</div>
      <div class="session-date">${escapeHtml(date)}</div>
      <div class="session-files">${fileCount} file(s), ${totalMb.toFixed(1)} MB total</div>
      ${filesHtml}
      <div class="session-actions">
        ${fileCount > 0 ? `<button class="btn btn-secondary btn-sm" data-action="download" data-session="${escapeHtml(s.session_id)}">Download All</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete" data-session="${escapeHtml(s.session_id)}">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="download"]')?.addEventListener('click', () => downloadSessionFiles(s));
    card.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteSession(s.session_id));
    $('sessions-list').appendChild(card);
  }

  for (const s of guestSessions) {
    const mb = ((s.file_size || 0) / 1048576).toFixed(1);
    const date = s.created_at ? new Date(s.created_at).toLocaleString() : '';
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-name">${escapeHtml(s.session_name || 'Untitled')} <span class="guest-tag">guest</span></div>
      <div class="session-date">${escapeHtml(date)} · host: ${escapeHtml(s.host || '?')}</div>
      <div class="session-files">Your recording: ${mb} MB</div>
      <div class="session-actions">
        <button class="btn btn-secondary btn-sm" data-action="download">Download My File</button>
        <button class="btn btn-danger btn-sm" data-action="forget">Remove from list</button>
      </div>
    `;
    card.querySelector('[data-action="download"]').addEventListener('click', () => downloadGuestFile(s));
    card.querySelector('[data-action="forget"]').addEventListener('click', () => {
      if (!confirm('Remove this session from your local list? The file stays on the server.')) return;
      removeGuestSession(s.session_id, s.host, s.user);
      loadSessions();
    });
    $('sessions-list').appendChild(card);
  }
}

async function downloadGuestFile(s) {
  showStatus('sessions', 'Downloading…', 'info');
  const sessionName = s.session_name || 'Session';
  const created = s.created_at ? new Date(s.created_at) : new Date();
  const stamp = created.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const safeUser = (s.user || '').replace(/[^a-zA-Z0-9 _-]/g, '_');
  const safeSession = sessionName.replace(/[^a-zA-Z0-9 _-]/g, '_').trim();
  const parts = [stamp, safeSession, safeUser].filter(Boolean);
  const filename = parts.join('_') + '.wav';
  const result = await library.downloadFile({
    hostUser: s.host,
    sessionId: s.session_id,
    fileUser: s.user,
    mode: 'guest',
    requester: s.user,
    room: s.room || '',
    pin: s.pin || '',
  });
  if (result.ok) {
    triggerDownload(result.blob, filename);
    showStatus('sessions', 'Downloaded.', 'success');
  } else {
    showStatus('sessions', 'Download failed: ' + result.error, 'error');
  }
}

async function downloadSessionFiles(session) {
  showStatus('sessions', 'Downloading…', 'info');
  let ok = 0, err = 0;
  const sessionName = session.session_name || 'Session';
  const created = session.created_at ? new Date(session.created_at) : new Date();
  const stamp = created.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');

  for (const [fileUser] of Object.entries(session.files || {})) {
    const safeUser = fileUser.replace(/[^a-zA-Z0-9 _-]/g, '_');
    const safeSession = sessionName.replace(/[^a-zA-Z0-9 _-]/g, '_').trim();
    const parts = [stamp, safeSession, safeUser].filter(Boolean);
    const filename = parts.join('_') + '.wav';
    const result = await library.downloadFile({
      hostUser: config.username,
      sessionId: session.session_id,
      fileUser,
      requester: config.username,
      password: config.library_password,
    });
    if (result.ok) {
      triggerDownload(result.blob, filename);
      ok++;
    } else {
      err++;
    }
  }
  if (err > 0) showStatus('sessions', `Downloaded ${ok}, ${err} failed.`, 'warning');
  else         showStatus('sessions', `Downloaded ${ok} file(s).`, 'success');
}

async function deleteSession(sessionId) {
  if (!confirm('Delete this session from the server? Your local copy is not affected.')) return;
  showStatus('sessions', 'Deleting…', 'info');
  const result = await library.deleteSession(config.username, config.library_password, sessionId);
  if (result.ok) loadSessions();
  else showStatus('sessions', 'Delete failed: ' + result.error, 'error');
}

// ── Mic helpers shared across screens ──
//
// getUserMedia errors on the web come in a few flavours; the browser's
// default `e.message` is often useless ("Permission denied"). We turn
// them into something actionable for a podcast host.
function micErrorMessage(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was blocked. See the on-screen guide for how to un-block it for this site.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found, or the selected device is unavailable. Pick a different mic in Settings → Default Microphone.';
  }
  if (name === 'NotReadableError') {
    return 'Another app is using your microphone (Zoom, Discord, etc.). Close it and try again.';
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return 'This browser does not expose microphone APIs. Open the app in Chrome or Edge.';
  }
  // Worklet-loading failures. Distinguish between the common "try
  // refresh" case and the CSP-sandbox case where nothing we can do
  // in JS will help.
  if (name === 'WorkletLoadError' || /worklet/i.test(e?.message || '')) {
    if (/Content Security Policy|CSP|violates/i.test(e?.message || '')) {
      return 'This site\'s Content Security Policy blocks the audio worklet. If you\'re on an online sandbox (playcode.io, JSFiddle, CodeSandbox, etc.), those environments don\'t allow the APIs PodSync needs. Open the webapp at http://localhost:8080 or on your own Hetzner-hosted URL instead.';
    }
    return 'Audio worklet failed to load. Try reloading the page. If it keeps happening, open the browser console and share the error.';
  }
  return 'Could not open microphone: ' + (e?.message || e);
}

function isEmbeddedBrowserError(e) {
  const name = e?.name || '';
  // We only treat NotAllowed/SecurityError as "embedded" when the API
  // surface is also missing or weird; a genuine user-declined prompt
  // should route to the un-block modal instead.
  return !navigator.mediaDevices || typeof navigator.mediaDevices?.getUserMedia !== 'function';
}

function isPermissionBlocked(e) {
  return e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
}

// If the browser exposes the Permissions API, proactively check
// whether the user has pre-blocked mic access. Returns 'granted',
// 'denied', 'prompt', or 'unknown'.
async function queryMicPermission() {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Show the blocked-mic modal with per-browser fix instructions.
// Takes an optional `onRetry` for the "Try Again" button; defaults to
// a no-op (caller decides what to do next).
let _blockedRetryHandler = null;
function showMicBlockedModal(onRetry) {
  _blockedRetryHandler = onRetry || null;
  $('mic-blocked-modal').classList.remove('hidden');
}
function hideMicBlockedModal() {
  $('mic-blocked-modal').classList.add('hidden');
}

// Wire modal buttons once.
document.addEventListener('DOMContentLoaded', () => {
  $('mic-blocked-close').addEventListener('click', hideMicBlockedModal);
  $('mic-blocked-retry').addEventListener('click', async () => {
    hideMicBlockedModal();
    if (_blockedRetryHandler) {
      try { await _blockedRetryHandler(); } catch {}
    }
  });
}, { once: true });

// Wire one mic <select> to the global config.input_device. On change
// we save immediately so every other screen sees the same selection.
// Must be called once per select during screen setup.
function bindMicSelectToConfig(selectId) {
  const sel = $(selectId);
  if (!sel || sel.dataset.bound === '1') return;
  sel.dataset.bound = '1';
  sel.addEventListener('change', () => {
    config.input_device = sel.value || '';
    const label = sel.selectedOptions[0]?.textContent || '';
    config.input_device_label = label;
    saveConfig(config);
    // Mirror into any OTHER mic selects currently mounted so the UI
    // never shows two different "selected" mics across screens.
    for (const id of ['settings-mic', 'test-input', 'host-mic', 'guest-mic']) {
      if (id === selectId) continue;
      const other = $(id);
      if (other && other.value !== sel.value) other.value = sel.value;
    }
  });
}

// Populate a <select> with input devices. Tries to prompt for mic
// permission first so labels are readable, but tolerates denial -
// if permission is refused we still list anonymous "Microphone N"
// entries so the user can pick something rather than staring at an
// empty dropdown.
async function populateMicSelect(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">System Default</option>';

  // If we already know permission is denied, skip the probe (which
  // would throw NotAllowedError without prompting) and surface the
  // un-block modal so the user can actually fix it.
  const permState = await queryMicPermission();
  if (permState === 'denied') {
    showMicBlockedModal(() => populateMicSelect(selectId));
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.textContent = 'Microphone access blocked';
    sel.appendChild(opt);
    return;
  }

  // Soft permission probe: succeeds → labels populate. Failure is
  // common in embedded webviews and shouldn't block the dropdown.
  let granted = false;
  try {
    if (navigator.mediaDevices?.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
      granted = true;
    }
  } catch (e) {
    if (isPermissionBlocked(e)) showMicBlockedModal(() => populateMicSelect(selectId));
    else if (isEmbeddedBrowserError(e)) showBrowserWarn();
  }

  const inputs = await listInputDevices();
  if (inputs.length === 0) {
    const opt = document.createElement('option');
    opt.disabled = true;
    opt.textContent = 'No microphones found';
    sel.appendChild(opt);
    return;
  }
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || (granted ? 'Unlabeled input' : 'Microphone (grant permission to see name)');
    if (d.deviceId === config.input_device) opt.selected = true;
    sel.appendChild(opt);
  }
  bindMicSelectToConfig(selectId);
}

// ── Test audio screen ──
async function populateTestDevices() {
  await populateMicSelect('test-input');
}

$('test-back').addEventListener('click', async () => {
  if (testRecorder) { try { await testRecorder.shutdown(); } catch {} testRecorder = null; }
  testBlob = null;
  $('test-record-area').classList.remove('hidden');
  $('test-stop-area').classList.add('hidden');
  $('test-play-area').classList.add('hidden');
  $('test-status').textContent = '';
  $('test-level').style.width = '0%';
  $('test-timer').textContent = '0:00 / 0:10';
  goTo('home');
});

$('test-record-btn').addEventListener('click', async () => {
  const deviceId = $('test-input').value || null;
  testRecorder = new Recorder();
  testRecorder.onLevel = (v) => { $('test-level').style.width = (v * 100) + '%'; };
  try {
    await testRecorder.arm(deviceId);
    testRecorder.start();
  } catch (e) {
    showStatus('test', micErrorMessage(e), 'error');
    testRecorder = null;
    if (isPermissionBlocked(e)) {
      showMicBlockedModal(() => $('test-record-btn').click());
    } else if (isEmbeddedBrowserError(e)) {
      showBrowserWarn();
    }
    return;
  }
  $('test-record-area').classList.add('hidden');
  $('test-stop-area').classList.remove('hidden');
  const startedAt = Date.now();
  clearInterval(testTimerInterval);
  testTimerInterval = setInterval(() => {
    const s = Math.min(10, (Date.now() - startedAt) / 1000);
    $('test-timer').textContent = `${s.toFixed(1)}s / 10s`;
    if (s >= 10) $('test-stop-btn').click();
  }, 100);
});

$('test-stop-btn').addEventListener('click', async () => {
  clearInterval(testTimerInterval);
  if (!testRecorder) return;
  testBlob = await testRecorder.stop();
  await testRecorder.shutdown();
  testRecorder = null;
  $('test-stop-area').classList.add('hidden');
  $('test-play-area').classList.remove('hidden');
  showStatus('test', testBlob ? 'Recorded. Press play to hear it back.' : 'No audio captured.', testBlob ? 'success' : 'warning');
});

$('test-play-btn').addEventListener('click', () => {
  if (!testBlob) return;
  const audio = new Audio(URL.createObjectURL(testBlob));
  audio.play();
  $('test-play-btn').textContent = '▶ Playing…';
  audio.onended = () => { $('test-play-btn').textContent = '▶ Play Back'; };
});

// ── Settings ──
async function populateSettings() {
  $('settings-display').value = config.display_name || '';
  $('settings-username').value = config.username || '';
  $('settings-email').value = config.email || '';
  $('settings-admin-token').value = config.admin_token || '';
  await populateMicSelect('settings-mic');
}

$('settings-save').addEventListener('click', async () => {
  const display = $('settings-display').value.trim();
  const email = $('settings-email').value.trim();
  const device = $('settings-mic').value;
  const deviceLabel = $('settings-mic').selectedOptions[0]?.textContent || '';

  config.display_name = display || config.display_name;
  config.email = email || config.email;
  config.input_device = device;
  config.input_device_label = deviceLabel;
  saveConfig(config);

  if (config.username && config.library_password && display && email) {
    try {
      await library.registerProfile(config.username, config.library_password, display, email);
    } catch {}
  }
  showStatus('settings', 'Saved.', 'success');
});

$('settings-change-pw').addEventListener('click', async () => {
  const oldPw = $('settings-old-pw').value;
  const newPw = $('settings-new-pw').value;
  if (!oldPw || !newPw) return showStatus('settings-pw', 'Enter both passwords.', 'error');
  if (newPw.length < 4)  return showStatus('settings-pw', 'New password must be at least 4 characters.', 'error');
  const r = await library.changePassword(config.username, oldPw, newPw);
  if (r.ok) {
    config.library_password = newPw;
    saveConfig(config);
    $('settings-old-pw').value = '';
    $('settings-new-pw').value = '';
    showStatus('settings-pw', 'Password changed.', 'success');
  } else {
    showStatus('settings-pw', r.error || 'Failed.', 'error');
  }
});

$('settings-logout').addEventListener('click', () => {
  if (!confirm('Log out of PodSync in this browser?')) return;
  clearConfig();
  config = loadConfig();
  goTo('welcome');
});

// ── Host/guest screen resets ──
function resetHostScreen() {
  $('host-pre').classList.remove('hidden');
  $('host-room').classList.add('hidden');
  $('host-record-area').classList.remove('hidden');
  $('host-stop-area').classList.add('hidden');
  $('host-timer').classList.add('hidden');
  $('host-post-actions').classList.add('hidden');
  $('host-upload-bar').classList.add('hidden');
  $('host-status').textContent = '';
  $('host-pre-status').textContent = '';
  $('host-participants').innerHTML = '';
  populateMicSelect('host-mic');
}
function resetGuestScreen() {
  $('guest-pre').classList.remove('hidden');
  $('guest-session').classList.add('hidden');
  $('guest-timer').classList.add('hidden');
  $('guest-upload-bar').classList.add('hidden');
  $('guest-post-actions')?.classList.add('hidden');
  $('guest-pre-status').textContent = '';
  $('guest-status').textContent = 'Waiting for host to start recording…';
  $('guest-status').className = 'status status-info';
  populateMicSelect('guest-mic');
}

// ── Settings: admin token ──
$('settings-admin-save').addEventListener('click', () => {
  const token = $('settings-admin-token').value.trim();
  config.admin_token = token;
  saveConfig(config);
  showStatus('settings-admin', token ? 'Admin token saved.' : 'Admin token cleared.', 'success');
  updateAdminVisibility();
});

// ── Admin panel ──
let _adminSessionFilter = null; // username to filter by, or null for all

function resetAdminScreen() {
  // Drop any pending requests so re-entering the screen mid-fetch
  // doesn't leave stale "Loading…" text glued to the card.
  try { _adminUsersCtl?.abort(); } catch {}
  try { _adminSessionsCtl?.abort(); } catch {}
  _adminUsersCtl = null;
  _adminSessionsCtl = null;
  $('admin-users-list').innerHTML = '';
  $('admin-sessions-list').innerHTML = '';
  $('admin-users-status').textContent = '';
  $('admin-sessions-status').textContent = '';
  _adminSessionFilter = null;
  updateAdminFilterBadge();
  switchAdminTab('users');
}

function switchAdminTab(tab) {
  for (const btn of document.querySelectorAll('.admin-tab')) {
    btn.classList.toggle('active', btn.dataset.adminTab === tab);
  }
  $('admin-tab-users').classList.toggle('hidden', tab !== 'users');
  $('admin-tab-sessions').classList.toggle('hidden', tab !== 'sessions');
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-admin-tab]');
  if (t) switchAdminTab(t.dataset.adminTab);
});

function updateAdminFilterBadge() {
  const badge = $('admin-sessions-filter-badge');
  const clearBtn = $('admin-clear-filter');
  if (_adminSessionFilter) {
    badge.textContent = `Filtered: ${_adminSessionFilter}`;
    badge.classList.remove('hidden');
    clearBtn.style.display = '';
  } else {
    badge.classList.add('hidden');
    clearBtn.style.display = 'none';
  }
}

$('admin-clear-filter').addEventListener('click', () => {
  _adminSessionFilter = null;
  updateAdminFilterBadge();
  loadAdminSessions();
});

$('admin-load-users').addEventListener('click', loadAdminUsers);
$('admin-load-sessions').addEventListener('click', loadAdminSessions);

async function loadAdminUsers() {
  const token = (config.admin_token || '').trim();
  if (!token) return showStatus('admin-users', 'Set an admin token in Settings first.', 'warning');
  try { _adminUsersCtl?.abort(); } catch {}
  const ctl = new AbortController();
  _adminUsersCtl = ctl;
  showStatus('admin-users', 'Loading users…', 'info');
  const r = await library.adminListUsers(token, { signal: ctl.signal });
  if (ctl.signal.aborted || _adminUsersCtl !== ctl) return;
  if (!r.ok) return showStatus('admin-users', 'Failed: ' + r.error, 'error');

  showStatus('admin-users', `${r.users.length} user(s).`, 'success');
  const host = $('admin-users-list');
  host.innerHTML = '';
  for (const u of r.users) {
    const card = document.createElement('div');
    card.className = 'admin-user-card';
    const storage = u.total_bytes != null ? `${(u.total_bytes / 1048576).toFixed(1)} MB` : '—';
    const sessionCount = u.session_count ?? '—';
    card.innerHTML = `
      <div class="user-name">${escapeHtml(u.username || '(unknown)')}</div>
      <div class="user-stats">
        <span><span class="stat-label">Display:</span>${escapeHtml(u.display_name || '—')}</span>
        <span><span class="stat-label">Email:</span>${escapeHtml(u.email || '—')}</span>
        <span><span class="stat-label">Sessions:</span>${escapeHtml(String(sessionCount))}</span>
        <span><span class="stat-label">Storage:</span>${escapeHtml(storage)}</span>
      </div>
      <div class="user-actions">
        <button class="btn btn-secondary btn-sm" data-action="sessions">View Sessions</button>
        <button class="btn btn-danger btn-sm" data-action="reset">Reset Password</button>
      </div>
    `;
    card.querySelector('[data-action="sessions"]').addEventListener('click', () => {
      _adminSessionFilter = u.username;
      updateAdminFilterBadge();
      switchAdminTab('sessions');
      loadAdminSessions();
    });
    card.querySelector('[data-action="reset"]').addEventListener('click', async () => {
      if (!confirm(`Reset password for ${u.username}? They will need to log in again with a new password.`)) return;
      const rr = await library.adminResetPassword(token, u.username);
      showStatus('admin-users', rr.ok ? (rr.message || 'Password reset.') : 'Reset failed: ' + rr.error, rr.ok ? 'success' : 'error');
    });
    host.appendChild(card);
  }
}

async function loadAdminSessions() {
  const token = (config.admin_token || '').trim();
  if (!token) return showStatus('admin-sessions', 'Set an admin token in Settings first.', 'warning');
  try { _adminSessionsCtl?.abort(); } catch {}
  const ctl = new AbortController();
  _adminSessionsCtl = ctl;
  const filterLabel = _adminSessionFilter ? ` for ${_adminSessionFilter}` : '';
  showStatus('admin-sessions', `Loading sessions${filterLabel}…`, 'info');
  const r = await library.adminListSessions(token, _adminSessionFilter || '', { signal: ctl.signal });
  if (ctl.signal.aborted || _adminSessionsCtl !== ctl) return;
  if (!r.ok) return showStatus('admin-sessions', 'Failed: ' + r.error, 'error');

  showStatus('admin-sessions', `${r.sessions.length} session(s)${filterLabel}.`, 'success');
  const host = $('admin-sessions-list');
  host.innerHTML = '';
  if (r.sessions.length === 0) return;
  for (const s of r.sessions) {
    // /admin/sessions returns aggregates per session (file_count +
    // total_bytes), NOT the per-user files dict that /library/list
    // returns. Fall back to s.files if a future server build adds it
    // so the UI stays informative instead of showing "0 files".
    const filesDict = s.files && typeof s.files === 'object' ? s.files : null;
    const fileCount = s.file_count != null
      ? s.file_count
      : (filesDict ? Object.keys(filesDict).length : 0);
    const totalBytes = s.total_bytes != null
      ? s.total_bytes
      : (filesDict ? Object.values(filesDict).reduce((sum, f) => sum + (f.size || 0), 0) : 0);
    const totalMb = totalBytes / 1048576;
    const date = s.created_at ? new Date(s.created_at).toLocaleString() : '';
    const filesHtml = filesDict
      ? Object.entries(filesDict)
          .map(([user, f]) => `<div class="session-file">${escapeHtml(user)} (${((f.size || 0) / 1048576).toFixed(1)} MB)</div>`)
          .join('')
      : '';
    const card = document.createElement('div');
    card.className = 'admin-session-card';
    card.innerHTML = `
      <div class="session-name">${escapeHtml(s.session_name || 'Untitled')}</div>
      <div class="session-date">${escapeHtml(date)} · host: ${escapeHtml(s.username || s.host || '?')}</div>
      <div class="session-files">${fileCount} file(s), ${totalMb.toFixed(1)} MB total</div>
      ${filesHtml}
      <div class="session-actions">
        <button class="btn btn-danger btn-sm" data-action="delete">Force Delete</button>
      </div>
    `;
    card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Force delete session ${s.session_id}? This bypasses the owner's password and cannot be undone.`)) return;
      const rr = await library.adminDeleteSession(token, s.session_id);
      if (rr.ok) {
        card.remove();
        showStatus('admin-sessions', 'Deleted.', 'success');
      } else {
        showStatus('admin-sessions', 'Delete failed: ' + rr.error, 'error');
      }
    });
    host.appendChild(card);
  }
}

// ── Embedded-browser detection ──
// Cursor's Simple Browser, VS Code preview, and most in-IDE webviews
// either lack `navigator.mediaDevices` entirely or refuse to prompt
// for mic permission. Show a banner that points the user at Chrome/
// Edge so they don't waste time debugging our CSS.
function detectEmbeddedBrowser() {
  const noMediaDevices = !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function';
  const ua = navigator.userAgent || '';
  // VS Code / Cursor embed "Electron" in UA. Other embedded webviews
  // often do too. Treat any Electron UA on a non-desktop app origin
  // as "probably embedded".
  const looksEmbedded = /Electron/i.test(ua) || ua.includes('VSCode');
  if (noMediaDevices || looksEmbedded) {
    showBrowserWarn();
  }
}

function showBrowserWarn() {
  const el = $('browser-warn');
  if (el && !el.dataset.dismissed) el.classList.remove('hidden');
}

$('warn-copy-url').addEventListener('click', () => {
  navigator.clipboard?.writeText(location.href).then(
    () => showToast('URL copied — paste into Chrome or Edge.'),
    () => showToast('Copy failed — select and copy manually: ' + location.href),
  );
});
$('warn-dismiss').addEventListener('click', () => {
  const el = $('browser-warn');
  el.dataset.dismissed = '1';
  el.classList.add('hidden');
});

// ── Boot ──
window.addEventListener('DOMContentLoaded', () => {
  detectEmbeddedBrowser();
  const hasAccount = !!(config.is_setup || config.username);
  goTo(hasAccount ? 'home' : 'welcome');
});
