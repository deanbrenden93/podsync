/**
 * PodSync relay WebSocket client. Mirrors network.py's RelayConnection.
 *
 * Same protocol on the wire - the Hetzner-hosted relay sees no
 * difference between a desktop client and a browser client. Messages
 * are JSON with a `type` field; both sides use ping/pong for keepalive.
 */

export const DEFAULT_RELAY_URL = 'wss://relay.eeriecast.com/ws';

export function generatePin() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export class RelayConnection {
  constructor(relayUrl = '') {
    this.relayUrl = relayUrl || DEFAULT_RELAY_URL;
    this._ws = null;
    this._connected = false;
    this._stopping = false;
    this.roomCode = '';
    this.pin = '';

    // Callbacks.
    this.onConnected = null;
    this.onDenied = null;
    this.onParticipants = null;
    this.onPrepare = null;
    this.onStop = null;
    this.onSyncTone = null;
    this.onDisconnected = null;
    this.onHostLeft = null;
    this.onError = null;
    this.onPeerLevel = null;
    this.onSyncToneAck = null;
  }

  get isConnected() { return this._connected; }

  connectAsHost(name, pin = '', room = '') {
    this.roomCode = room || generateRoomCode();
    this.pin = pin || generatePin();
    this._open(name, 'host', this.roomCode, this.pin);
    return { room: this.roomCode, pin: this.pin };
  }

  connectAsGuest(name, room, pin) {
    this.roomCode = (room || '').toUpperCase();
    this.pin = pin;
    this._open(name, 'guest', this.roomCode, this.pin);
  }

  _open(name, role, room, pin) {
    this._stopping = false;
    const url = `${this.relayUrl}?room=${encodeURIComponent(room)}&pin=${encodeURIComponent(pin)}&name=${encodeURIComponent(name)}&role=${role}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      if (this.onError) this.onError(String(e));
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      this._connected = true;
      // Server sends `welcome` itself; we don't need to announce.
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      switch (data.type) {
        case 'welcome':
          this.onConnected?.(data.session_name || '');
          break;
        case 'participants':
          this.onParticipants?.(data.users || []);
          break;
        case 'prepare':
          this.onPrepare?.(data.start_at || Date.now() / 1000,
                          data.session_name || '',
                          data.session_id || '');
          break;
        case 'stop':
          this.onStop?.();
          break;
        case 'sync_tone':
          this.onSyncTone?.();
          break;
        case 'host_disconnected':
          this.onHostLeft?.();
          break;
        case 'level':
          this.onPeerLevel?.(data.name || '', Number(data.level) || 0);
          break;
        case 'sync_tone_ack':
          this.onSyncToneAck?.(data.name || '');
          break;
        case 'ping':
          this._send({ type: 'pong' });
          break;
      }
    };

    ws.onerror = () => {
      // The close handler runs next with the real reason; don't
      // fire onError twice.
    };

    ws.onclose = (ev) => {
      this._connected = false;
      this._ws = null;
      // 4xx-ish close codes map to server-side denials (bad pin, etc).
      if (ev.code === 4403 || ev.reason?.includes('403')) {
        this.onDenied?.('Invalid PIN');
      } else if (ev.code === 4404 || ev.reason?.includes('404')) {
        this.onDenied?.('Room does not exist yet. Host must create it first.');
      } else if (!this._stopping && !ev.wasClean && this.onError) {
        this.onError(ev.reason || `WebSocket closed (code ${ev.code})`);
      }
      this.onDisconnected?.();
    };
  }

  sendReady()         { this._send({ type: 'ready' }); }
  sendLevel(level)    { this._send({ type: 'level', level: Number(level) }); }
  sendSessionName(n)  { this._send({ type: 'set_session_name', session_name: n }); }
  sendStart(n, id)    { this._send({ type: 'prepare', session_name: n || '', session_id: id || '' }); }
  sendStop()          { this._send({ type: 'stop' }); }
  sendSyncTone()      { this._send({ type: 'sync_tone' }); }
  sendSyncToneAck(n)  { this._send({ type: 'sync_tone_ack', name: n }); }

  disconnect() {
    this._stopping = true;
    this._connected = false;
    try { this._ws?.close(); } catch {}
  }

  _send(obj) {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}
