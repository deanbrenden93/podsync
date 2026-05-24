/**
 * PodSync library HTTP client. Mirrors library.py's LibraryClient.
 *
 * Same endpoints on the same Hetzner host. Upload uses XMLHttpRequest
 * instead of fetch because XHR exposes real on-wire progress via its
 * `progress` event, while fetch only does response progress.
 */

export const DEFAULT_LIBRARY_BASE = 'https://relay.eeriecast.com';

// Match library.py's multipart threshold so we behave the same as the
// desktop client. Browsers can send quite large bodies via XHR in one
// shot on modern networks but the relay's Worker still caps inbound
// at 100 MB per request, so switching at 50 MB is the safe threshold.
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
const MULTIPART_PART_SIZE = 25 * 1024 * 1024;
const MULTIPART_PART_RETRIES = 3;


export class LibraryClient {
  constructor(baseUrl = '') {
    this.base = (baseUrl || DEFAULT_LIBRARY_BASE).replace(/\/+$/, '');
    // Accept ws(s) URLs too, for symmetry with library.py.
    if (this.base.startsWith('ws://'))  this.base = 'http://'  + this.base.slice(5);
    if (this.base.startsWith('wss://')) this.base = 'https://' + this.base.slice(6);
  }

  async _request(path, { method = 'GET', headers = {}, body = null, params = null, signal = null, timeoutMs = 30000 } = {}) {
    let url = this.base + path;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += '?' + qs;
    }
    const h = { 'User-Agent': 'PodSync-Web/1.0', ...headers };
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      body = JSON.stringify(body);
    }

    // Per-request abort controller so we can (a) cap every call with a
    // timeout and (b) chain a caller-supplied signal. Without this, a
    // silently stalled connection pinned the "Loading…" state in the
    // sessions + admin screens until the user reloaded the tab.
    const ac = new AbortController();
    const onOuterAbort = () => ac.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason);
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => ac.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
      : null;

    let resp;
    try {
      resp = await fetch(url, { method, headers: h, body, mode: 'cors', signal: ac.signal });
    } catch (e) {
      const aborted = ac.signal.aborted;
      const cancelled = aborted && !!signal?.aborted;
      const timedOut = aborted && !cancelled;
      const msg = cancelled ? 'cancelled' : timedOut ? 'Request timed out' : String(e);
      return { status: 0, data: { error: msg }, aborted, cancelled };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: resp.status, data };
  }

  // ── Session registration + lifecycle ──

  async registerSession({ username, password, session_id, session_name, room, pin, participants }) {
    const { status, data } = await this._request('/library/register-session', {
      method: 'POST',
      body: { username, password, session_id, session_name, room, pin, participants },
    });
    if (status === 200 && data.ok) return { ok: true };
    return { ok: false, error: data.error || `HTTP ${status}` };
  }

  /**
   * Upload a Blob to the relay. `onProgress(sent, total)` fires as
   * bytes flush to the socket. Auto-routes to multipart for files
   * over MULTIPART_THRESHOLD.
   */
  async uploadBlob({ hostUser, sessionId, guestUser, room, pin, blob, onProgress }) {
    if (blob.size < MULTIPART_THRESHOLD) {
      return this._uploadSingle({ hostUser, sessionId, guestUser, room, pin, blob, onProgress });
    }
    return this._uploadMultipart({ hostUser, sessionId, guestUser, room, pin, blob, onProgress });
  }

  _uploadSingle({ hostUser, sessionId, guestUser, room, pin, blob, onProgress }) {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        host: hostUser, session_id: sessionId, user: guestUser,
      });
      const url = `${this.base}/library/upload?${params.toString()}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'audio/wav');
      xhr.setRequestHeader('X-Session-Room', room);
      xhr.setRequestHeader('X-Session-Pin', pin);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) {
          try { onProgress(ev.loaded, ev.total); } catch {}
        }
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          resolve({ ok: true });
        } else {
          let err;
          try { err = JSON.parse(xhr.responseText).error; } catch { err = xhr.responseText?.slice(0, 200); }
          resolve({ ok: false, error: err || `HTTP ${xhr.status}` });
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: 'Network error' });
      xhr.onabort = () => resolve({ ok: false, error: 'Upload aborted' });
      xhr.send(blob);
    });
  }

  async _uploadMultipart({ hostUser, sessionId, guestUser, room, pin, blob, onProgress }) {
    const totalSize = blob.size;
    const paramsCommon = new URLSearchParams({
      host: hostUser, session_id: sessionId, user: guestUser,
    }).toString();
    const auth = { 'X-Session-Room': room, 'X-Session-Pin': pin };

    // 1. start
    const startResp = await this._request('/library/upload-start', {
      method: 'POST',
      params: { host: hostUser, session_id: sessionId, user: guestUser },
      headers: auth,
      body: { total_size: totalSize },
    });
    if (startResp.status !== 200 || !startResp.data.ok) {
      return { ok: false, error: startResp.data.error || `Start failed (${startResp.status})` };
    }
    const uploadId = startResp.data.upload_id;
    const reservationId = startResp.data.reservation_id;
    const parts = [];

    const abort = async () => {
      try {
        await this._request('/library/upload-abort', {
          method: 'POST',
          params: { host: hostUser, session_id: sessionId, user: guestUser },
          headers: auth,
          body: reservationId ? { upload_id: uploadId, reservation_id: reservationId } : { upload_id: uploadId },
        });
      } catch {}
    };

    // 2. each part
    let bytesSent = 0;
    let partNumber = 1;
    for (let offset = 0; offset < totalSize; offset += MULTIPART_PART_SIZE, partNumber++) {
      const chunk = blob.slice(offset, Math.min(offset + MULTIPART_PART_SIZE, totalSize));
      let lastErr = null;
      let success = false;
      for (let attempt = 0; attempt < MULTIPART_PART_RETRIES; attempt++) {
        const result = await this._uploadPart({
          hostUser, sessionId, guestUser, room, pin,
          uploadId, partNumber, chunk,
          onByte: (bytesInPart) => {
            if (onProgress) {
              try { onProgress(bytesSent + bytesInPart, totalSize); } catch {}
            }
          },
        });
        if (result.ok) {
          parts.push({ part_number: result.partNumber, etag: result.etag });
          success = true;
          break;
        }
        lastErr = result.error;
        if (result.serverResponded) break; // don't retry a deterministic rejection
      }
      if (!success) {
        await abort();
        return { ok: false, error: `Part ${partNumber} failed: ${lastErr || 'unknown'}` };
      }
      bytesSent += chunk.size;
      if (onProgress) { try { onProgress(bytesSent, totalSize); } catch {} }
    }

    // 3. complete
    const completeResp = await this._request('/library/upload-complete', {
      method: 'POST',
      params: { host: hostUser, session_id: sessionId, user: guestUser },
      headers: auth,
      body: {
        upload_id: uploadId,
        reservation_id: reservationId,
        parts,
      },
    });
    if (completeResp.status !== 200 || !completeResp.data.ok) {
      await abort();
      return { ok: false, error: completeResp.data.error || `Complete failed (${completeResp.status})` };
    }
    if (onProgress) { try { onProgress(totalSize, totalSize); } catch {} }
    return { ok: true };
  }

  _uploadPart({ hostUser, sessionId, guestUser, room, pin, uploadId, partNumber, chunk, onByte }) {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        host: hostUser, session_id: sessionId, user: guestUser,
        upload_id: uploadId, part_number: String(partNumber),
      });
      const url = `${this.base}/library/upload-part?${params.toString()}`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Session-Room', room);
      xhr.setRequestHeader('X-Session-Pin', pin);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onByte) onByte(ev.loaded);
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          let data;
          try { data = JSON.parse(xhr.responseText); } catch { data = null; }
          if (data?.ok) {
            resolve({ ok: true, partNumber: data.part_number, etag: data.etag, serverResponded: true });
          } else {
            resolve({ ok: false, error: data?.error || 'Bad part response', serverResponded: true });
          }
        } else {
          let err;
          try { err = JSON.parse(xhr.responseText).error; } catch { err = `HTTP ${xhr.status}`; }
          resolve({ ok: false, error: err, serverResponded: true });
        }
      };
      xhr.onerror = () => resolve({ ok: false, error: 'Network error', serverResponded: false });
      xhr.onabort = () => resolve({ ok: false, error: 'Aborted', serverResponded: false });
      xhr.send(chunk);
    });
  }

  // ── Listing + downloads + deletion ──

  async listHostSessions(username, password, { signal } = {}) {
    const { status, data, cancelled } = await this._request('/library/list', {
      method: 'GET',
      params: { mode: 'host', user: username },
      headers: { 'X-Library-Password': password },
      signal,
    });
    if (status === 200 && data.ok) return { ok: true, sessions: data.sessions || [] };
    return { ok: false, cancelled, error: data.error || `HTTP ${status}` };
  }

  async listGuestSessions(hostUser, guestUser, room, pin, { signal } = {}) {
    const { status, data, cancelled } = await this._request('/library/list', {
      method: 'GET',
      params: { mode: 'guest', host: hostUser, user: guestUser },
      headers: { 'X-Session-Room': room, 'X-Session-Pin': pin },
      signal,
    });
    if (status === 200 && data.ok) return { ok: true, sessions: data.sessions || [] };
    return { ok: false, cancelled, error: data.error || `HTTP ${status}` };
  }

  /**
   * Returns a URL for downloading a single session file. The browser
   * will prompt the user to save it (via <a download>).
   */
  downloadUrl({ hostUser, sessionId, fileUser, mode = 'host', requester = '' }) {
    const params = new URLSearchParams({
      host: hostUser, session_id: sessionId, file_user: fileUser,
      mode, user: requester || hostUser,
    });
    return `${this.base}/library/download?${params.toString()}`;
  }

  /**
   * Download a single file as a Blob so we can force a filename on
   * save. Fetches with auth headers, surfaces progress. Returns
   * { ok, blob } or { ok: false, error }.
   */
  async downloadFile({ hostUser, sessionId, fileUser, mode = 'host', requester, password, room = '', pin = '', onProgress }) {
    const params = new URLSearchParams({
      host: hostUser, session_id: sessionId, file_user: fileUser,
      mode, user: requester,
    });
    const url = `${this.base}/library/download?${params.toString()}`;
    const headers = { 'User-Agent': 'PodSync-Web/1.0' };
    if (password) headers['X-Library-Password'] = password;
    if (room) headers['X-Session-Room'] = room;
    if (pin) headers['X-Session-Pin'] = pin;

    let resp;
    try {
      resp = await fetch(url, { method: 'GET', headers, mode: 'cors' });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    if (!resp.ok) {
      let err;
      try { err = (await resp.json()).error; } catch { err = `HTTP ${resp.status}`; }
      return { ok: false, error: err };
    }

    // Stream with progress.
    const total = Number(resp.headers.get('Content-Length') || 0);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) { try { onProgress(received, total); } catch {} }
    }
    return { ok: true, blob: new Blob(chunks, { type: 'audio/wav' }) };
  }

  async deleteSession(username, password, sessionId) {
    const { status, data } = await this._request('/library/delete', {
      method: 'POST',
      body: { username, password, session_id: sessionId },
    });
    if (status === 200 && data.ok) return { ok: true };
    return { ok: false, error: data.error || `HTTP ${status}` };
  }

  async getUsage(username, password, { signal } = {}) {
    const { status, data, cancelled } = await this._request('/library/usage', {
      method: 'GET',
      params: { user: username },
      headers: { 'X-Library-Password': password },
      signal,
    });
    if (status === 200 && data.ok) return { ok: true, usage: data };
    return { ok: false, cancelled, error: data.error || `HTTP ${status}` };
  }

  async changePassword(username, oldPassword, newPassword) {
    const { status, data } = await this._request('/library/change-password', {
      method: 'POST',
      body: { username, oldPassword, newPassword },
    });
    if (status === 200 && data.ok) return { ok: true };
    return { ok: false, error: data.error || `HTTP ${status}` };
  }

  async registerProfile(username, password, displayName, email) {
    const { status, data } = await this._request('/library/register-profile', {
      method: 'POST',
      body: { username, password, display_name: displayName, email },
    });
    if (status === 200 && data.ok) return { ok: true };
    return { ok: false, error: data.error || `HTTP ${status}` };
  }

  // ── Admin (requires X-Admin-Token header) ──
  // Server returns 401 on bad/missing token; surface it as a clean
  // error so the UI can prompt the user to re-check their token.

  async adminListUsers(adminToken, { signal } = {}) {
    const { status, data, cancelled } = await this._request('/admin/users', {
      method: 'GET',
      headers: { 'X-Admin-Token': adminToken },
      signal,
    });
    if (status === 200 && data.ok) return { ok: true, users: data.users || [] };
    return { ok: false, cancelled, error: data.error || `HTTP ${status}` };
  }

  async adminListSessions(adminToken, username = '', { signal } = {}) {
    const { status, data, cancelled } = await this._request('/admin/sessions', {
      method: 'GET',
      params: username ? { username } : null,
      headers: { 'X-Admin-Token': adminToken },
      signal,
    });
    if (status === 200 && data.ok) return { ok: true, sessions: data.sessions || [] };
    return { ok: false, cancelled, error: data.error || `HTTP ${status}` };
  }

  async adminResetPassword(adminToken, username) {
    const { status, data } = await this._request('/admin/reset-password', {
      method: 'POST',
      headers: { 'X-Admin-Token': adminToken },
      body: { username },
    });
    if (status === 200 && data.ok) return { ok: true, message: data.message || 'Password cleared.' };
    return { ok: false, error: data.error || `HTTP ${status}` };
  }

  async adminDeleteSession(adminToken, sessionId) {
    const { status, data } = await this._request(`/admin/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': adminToken },
    });
    if (status === 200 && data.ok) return { ok: true };
    return { ok: false, error: data.error || `HTTP ${status}` };
  }
}
