/**
 * PodSync browser recorder.
 *
 * Mirrors the Python `Recorder` API surface as closely as makes sense
 * in a browser:
 *
 *   arm()                  - open mic + AudioWorklet, start discarding samples
 *                            until start(). Listeners still get live level.
 *   start()                - flip the flag; from here on, every audio chunk
 *                            is written into an accumulating PCM buffer.
 *   stop()                 -> Blob                - builds a WAV blob and returns it
 *   shutdown()             - fully release mic + worklet + audio context
 *   injectTone()           - 100ms 1kHz beep (matches Python Recorder)
 *   padSilence(seconds)    - write silent samples (for mic-reconnect gap)
 *   pauseCapture()         - used on mic drop (kept as a no-op for now;
 *                            browsers usually recover automatically)
 *   resumeCapture(device)  - reopen stream on a different device
 *   onLevel / onDisconnect - settable callbacks
 *
 * Quality: constraints explicitly disable all browser audio processing
 * (echoCancellation, noiseSuppression, autoGainControl) and request
 * 48 kHz mono. We take Float32 straight from the worklet and write it
 * as 16-bit signed-PCM WAV at stop(). That's the same bit depth and
 * sample rate the desktop app produces.
 */

const TARGET_SAMPLE_RATE = 48000;
const TARGET_CHANNELS = 1;
const TARGET_BIT_DEPTH = 16;


/**
 * The AudioWorklet source, inlined as a string.
 *
 * AudioWorkletNode requires loading the processor from a separate
 * file via addModule(url). We originally loaded `./worklet.js`, but
 * across the zoo of hosting environments we need to support (Cursor's
 * preview, file://, http dev server, nginx on Hetzner, proxied reverse
 * tunnels) we hit MIME mismatches, 404s, and URL-resolution bugs.
 *
 * Inlining the processor as a string and handing it to the browser
 * as a Blob URL eliminates all of that: no HTTP request, no MIME
 * dependency, no base-URL arithmetic. The browser sees a same-origin
 * JavaScript blob and loads it. This is the same trick Tone.js and
 * Ableton's web audio tooling use.
 *
 * If you edit this, keep `webapp/js/worklet.js` in sync - that file
 * still exists for reference and remains usable if we ever want to
 * go back to the file-based loader.
 */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.BATCH_SAMPLES = 1024;
    this._buf = new Float32Array(this.BATCH_SAMPLES);
    this._bufIdx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._bufIdx++] = ch[i];
      if (this._bufIdx >= this.BATCH_SAMPLES) {
        const out = this._buf;
        this._buf = new Float32Array(this.BATCH_SAMPLES);
        this._bufIdx = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

/**
 * Try a ladder of worklet-loading strategies. Different hosting
 * environments block different schemes:
 *
 *   - Most places: blob: URLs work. Fast, no HTTP round trip.
 *   - Hosts with strict CSP (e.g. playcode.io): block blob: but
 *     allow same-origin files. We fall back to the bundled worklet.js.
 *   - Rare cases: neither works. We throw a specific error so the UI
 *     can explain the situation instead of showing "module failed".
 *
 * Returns on first success. Throws a WorkletLoadError listing every
 * strategy that was tried and why each failed.
 */
async function _loadWorklet(ctx) {
  const errors = [];

  // Strategy 1: Blob URL from inline source. Preferred - no network,
  // no MIME dependency.
  try {
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
      return;
    } finally {
      // Revoke now that the worklet has (either) loaded or failed.
      // Browsers hold onto the already-registered processor even
      // after the URL is revoked, so no leak.
      try { URL.revokeObjectURL(url); } catch {}
    }
  } catch (e) {
    errors.push('blob: ' + (e?.message || e));
  }

  // Strategy 2: same-origin file relative to the document. Requires
  // webapp/js/worklet.js to be served by the host.
  try {
    const baseHref = (typeof document !== 'undefined' && document.baseURI) || location.href;
    const url = new URL('js/worklet.js', baseHref).href;
    await ctx.audioWorklet.addModule(url);
    return;
  } catch (e) {
    errors.push('file: ' + (e?.message || e));
  }

  // Strategy 3: absolute-from-origin (covers the common case where
  // baseURI has a weird trailing segment).
  try {
    await ctx.audioWorklet.addModule('/js/worklet.js');
    return;
  } catch (e) {
    errors.push('abs: ' + (e?.message || e));
  }

  const err = new Error(
    'Audio worklet could not be loaded. This usually means the hosting ' +
    'environment has a Content Security Policy that blocks both blob: ' +
    'URLs and same-origin scripts for worklets. Details: ' + errors.join(' | ')
  );
  err.name = 'WorkletLoadError';
  throw err;
}

export class Recorder {
  constructor() {
    this._ctx = null;
    this._stream = null;
    this._node = null;
    this._source = null;

    this._isArmed = false;
    this._isRecording = false;
    this._framesWritten = 0;

    // Two parallel storage paths. Only ONE is ever used per recording:
    //
    //   OPFS mode (`_useOpfs === true`): Float32 chunks are converted
    //     to int16 and streamed into an Origin Private File System
    //     file during recording. Memory stays flat no matter how long
    //     the session runs; stop() just rewrites the header and hands
    //     back the file as a Blob.
    //
    //   In-memory mode (fallback): Float32 chunks accumulate in
    //     `_chunks` and a full WAV blob is built at stop(). Used on
    //     browsers without OPFS write support, or when opening the
    //     OPFS file fails (e.g. out-of-quota).
    this._chunks = [];
    this._opfsFile = null;       // FileSystemFileHandle
    this._opfsWriter = null;     // FileSystemWritableFileStream
    this._opfsPosition = 0;      // byte offset of the next PCM write
    this._opfsWriteChain = Promise.resolve(); // serializes writes
    this._useOpfs = false;

    this._deviceId = null;
    this._actualSampleRate = TARGET_SAMPLE_RATE;

    this.onLevel = null;
    this.onDisconnect = null;

    this._disconnectSignaled = false;
  }

  get isRecording() { return this._isRecording; }
  get isArmed()     { return this._isArmed; }

  get elapsedSeconds() {
    if (this._framesWritten === 0) return 0;
    return this._framesWritten / this._actualSampleRate;
  }

  async arm(deviceId = null) {
    if (this._isArmed) return;
    this._deviceId = deviceId;

    // Constraints matter. The browser's default stack adds echo
    // cancellation, noise suppression, and AGC — all of which are
    // Google's cellphone-call DSP. For podcast recording you want
    // NONE of those. Set each to false explicitly AND in the advanced
    // array (some browsers only honor one or the other).
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: TARGET_CHANNELS,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Chrome-specific hints. Ignored by other browsers.
        googEchoCancellation: false,
        googAutoGainControl: false,
        googNoiseSuppression: false,
        googHighpassFilter: false,
        googTypingNoiseDetection: false,
      },
    };

    this._stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Request the context at the target rate. The browser may refuse
    // and give us the hardware's native rate - in that case we still
    // work, we just store the actual rate so the WAV header is right.
    try {
      this._ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      this._ctx = new AudioContext();
    }
    this._actualSampleRate = this._ctx.sampleRate;

    await _loadWorklet(this._ctx);

    this._node = new AudioWorkletNode(this._ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    this._node.port.onmessage = (ev) => this._onSamples(ev.data);

    this._source = this._ctx.createMediaStreamSource(this._stream);
    this._source.connect(this._node);

    // Browsers emit 'ended' on the mic track when a USB device is
    // unplugged mid-recording. Treat that as the equivalent of our
    // Python Recorder's watchdog disconnect signal.
    for (const track of this._stream.getAudioTracks()) {
      track.addEventListener('ended', () => this._signalDisconnect('Mic track ended'));
    }

    // Open the OPFS file up front. If this fails, we silently
    // fall back to the in-memory path.
    await this._tryOpenOpfs();

    this._isArmed = true;
    this._disconnectSignaled = false;
    this._chunks = [];
    this._framesWritten = 0;
  }

  async _tryOpenOpfs() {
    this._useOpfs = false;
    this._opfsFile = null;
    this._opfsWriter = null;
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    try {
      const root = await navigator.storage.getDirectory();
      // Per-browser unique filename so multiple tabs don't collide.
      const filename = `recording-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`;
      this._opfsFile = await root.getFileHandle(filename, { create: true });
      // FileSystemWritableFileStream: supports positioned writes, which
      // we need so we can rewrite the WAV header at stop() once we
      // know the final data size.
      this._opfsWriter = await this._opfsFile.createWritable();
      this._useOpfs = true;
    } catch (e) {
      // Safari < 16.4, Firefox before the writable API landed, quota
      // errors, private-browsing mode - any of these end up here.
      // Fall back to in-memory silently; app-level performance is
      // unchanged for short recordings.
      console.info('[recorder] OPFS unavailable, falling back to in-memory:', e?.message || e);
      this._useOpfs = false;
    }
  }

  async start() {
    if (!this._isArmed) {
      throw new Error('Recorder.start() called before arm()');
    }
    this._chunks = [];
    this._framesWritten = 0;

    // If we were using OPFS but the previous stop() closed and nulled
    // the writer, open a fresh OPFS file for this recording. This is
    // what lets a single armed room do multiple back-to-back recordings
    // (e.g. a host doing a quick test recording before the real one).
    // If OPFS reopen fails, _tryOpenOpfs flips _useOpfs to false and
    // we transparently fall back to the in-memory path.
    if (this._useOpfs && !this._opfsWriter) {
      await this._tryOpenOpfs();
    }

    if (this._useOpfs && this._opfsWriter) {
      // Reserve the first 44 bytes for the WAV header. We write a
      // zero-length placeholder now and rewrite with the real sizes
      // at stop(). Position counter points to the first byte of PCM
      // data so `_onSamples` can append starting there.
      const header = _buildWavHeader(0, this._actualSampleRate);
      this._opfsPosition = 44;
      this._opfsWriteChain = this._opfsWriter.write({ type: 'write', position: 0, data: header })
        .catch((e) => console.warn('[recorder] OPFS header write failed:', e));
    }
    this._isRecording = true;
  }

  /**
   * Stops recording. In OPFS mode the WAV header is rewritten with
   * the correct sizes and the file is handed back as a Blob. In
   * memory mode a fresh WAV blob is constructed from accumulated
   * Float32 chunks (original behavior). Stream stays armed either
   * way so a subsequent start() is near-instant.
   */
  async stop() {
    this._isRecording = false;

    if (this._useOpfs && this._opfsWriter) {
      // Wait for all queued chunk writes to flush.
      try { await this._opfsWriteChain; } catch {}

      // Rewrite the header at position 0 now that we know the total
      // data size. Without this step the file would claim a
      // zero-length RIFF chunk and editors would refuse to open it.
      const dataSize = this._framesWritten * TARGET_CHANNELS * (TARGET_BIT_DEPTH / 8);
      const header = _buildWavHeader(dataSize, this._actualSampleRate);
      try {
        await this._opfsWriter.write({ type: 'write', position: 0, data: header });
        await this._opfsWriter.close();
      } catch (e) {
        console.warn('[recorder] OPFS finalize failed:', e);
      }
      this._opfsWriter = null;

      try {
        // `File` extends `Blob`, so it flows straight into upload
        // and download code unchanged.
        return await this._opfsFile.getFile();
      } catch (e) {
        console.warn('[recorder] OPFS read-back failed:', e);
        return null;
      }
    }

    // In-memory fallback.
    if (this._chunks.length === 0) return null;
    return this._buildWav(this._chunks, this._actualSampleRate);
  }

  /**
   * Append `samples` (Float32Array) to whichever storage backend is
   * active. Used by injectTone / padSilence in addition to the main
   * audio callback path.
   */
  _appendSamples(samples) {
    if (this._useOpfs) {
      this._writePcmToOpfs(samples);
    } else {
      this._chunks.push(samples);
      this._framesWritten += samples.length;
    }
  }

  _writePcmToOpfs(float32) {
    if (!this._opfsWriter) return;
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = float32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const bytes = new Uint8Array(int16.buffer);
    const position = this._opfsPosition;
    this._opfsPosition += bytes.byteLength;
    this._framesWritten += float32.length;
    // Serialize writes so their on-disk order matches the audio
    // callback order, and so stop() can await completion.
    this._opfsWriteChain = this._opfsWriteChain.then(
      () => this._opfsWriter.write({ type: 'write', position, data: bytes })
    ).catch((e) => {
      console.warn('[recorder] OPFS chunk write failed:', e);
    });
  }

  injectTone() {
    if (!this._isRecording) return;
    const rate = this._actualSampleRate;
    const numSamples = Math.floor(rate * 0.1);
    const ramp = Math.max(1, Math.floor(rate * 0.003));
    const tone = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      let env = 1.0;
      if (i < ramp) env = i / ramp;
      else if (i > numSamples - ramp) env = (numSamples - i) / ramp;
      tone[i] = 0.9 * env * Math.sin(2 * Math.PI * 1000 * i / rate);
    }
    this._appendSamples(tone);
  }

  padSilence(seconds) {
    if (!this._isRecording || seconds <= 0) return;
    const n = Math.floor(seconds * this._actualSampleRate);
    if (n <= 0) return;
    this._appendSamples(new Float32Array(n));
  }

  pauseCapture() {
    // Browsers handle mic unplug + replug automatically in most
    // cases. If we ever need an explicit pause we can disconnect
    // the source here and reconnect on resume.
  }

  async resumeCapture(deviceId) {
    if (deviceId && deviceId !== this._deviceId) {
      await this.shutdown(/*keepChunks=*/true);
      await this.arm(deviceId);
      this._isRecording = this._chunks.length > 0;
    }
    return { ok: true };
  }

  /**
   * Fully release mic + worklet + context. Safe to call any time.
   * If keepChunks=true, the captured PCM buffer is preserved (used
   * during mic-reconnect so we resume into the same WAV file).
   */
  async shutdown(keepChunks = false) {
    this._isRecording = false;
    this._isArmed = false;
    try { this._source?.disconnect(); } catch {}
    try { this._node?.disconnect(); } catch {}
    try {
      if (this._stream) {
        for (const track of this._stream.getTracks()) track.stop();
      }
    } catch {}
    try {
      if (this._ctx && this._ctx.state !== 'closed') {
        await this._ctx.close();
      }
    } catch {}
    this._source = null;
    this._node = null;
    this._stream = null;
    this._ctx = null;

    // Close any open OPFS writer. If shutdown was triggered without
    // stop() (e.g. leaveSession after a mid-recording cancel) we
    // still want to release the handle so the next session can
    // open a fresh file without collision.
    if (this._opfsWriter) {
      try { await this._opfsWriter.close(); } catch {}
      this._opfsWriter = null;
    }
    this._opfsFile = null;
    this._opfsPosition = 0;
    this._opfsWriteChain = Promise.resolve();
    this._useOpfs = false;

    if (!keepChunks) {
      this._chunks = [];
      this._framesWritten = 0;
    }
  }

  // ── Internal helpers ──

  _onSamples(float32) {
    // Always update the level meter so the UI feels live even when
    // we're armed but not yet recording.
    if (this.onLevel) {
      let sum = 0;
      for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
      const rms = Math.sqrt(sum / float32.length);
      try { this.onLevel(Math.min(rms * 5, 1)); } catch {}
    }
    if (!this._isRecording) return;
    this._appendSamples(float32);
  }

  _signalDisconnect(reason) {
    if (this._disconnectSignaled) return;
    this._disconnectSignaled = true;
    if (this.onDisconnect) {
      try { this.onDisconnect(reason); } catch {}
    }
  }

  /**
   * Build a 16-bit PCM WAV Blob from accumulated Float32 chunks.
   * Byte-identical layout to what the Python Recorder produces.
   * Only used by the in-memory fallback path; OPFS mode streams
   * the same format directly to disk and only calls _buildWavHeader.
   */
  _buildWav(chunks, sampleRate) {
    let totalSamples = 0;
    for (const c of chunks) totalSamples += c.length;

    const blockAlign = TARGET_CHANNELS * (TARGET_BIT_DEPTH / 8);
    const dataSize = totalSamples * blockAlign;

    const header = _buildWavHeader(dataSize, sampleRate);
    const buffer = new ArrayBuffer(44 + dataSize);
    new Uint8Array(buffer).set(new Uint8Array(header), 0);
    const view = new DataView(buffer);

    let off = 44;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        let s = c[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}


/**
 * Construct a 44-byte WAV RIFF/WAVE header for PCM audio.
 *
 * `dataSize` is the number of PCM bytes that will follow the header.
 * Pass 0 to write a placeholder (we rewrite with the real value at
 * stop() time once all chunks have been streamed to OPFS).
 *
 * Returned as an ArrayBuffer so it's directly usable by both Blob
 * construction (in-memory path) and FileSystemWritableFileStream.write
 * (OPFS path).
 */
function _buildWavHeader(dataSize, sampleRate) {
  const bytesPerSample = TARGET_BIT_DEPTH / 8;
  const blockAlign = TARGET_CHANNELS * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  let off = 0;
  const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); off += s.length; };

  writeStr('RIFF');
  view.setUint32(off, 36 + dataSize, true); off += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(off, 16, true); off += 4;
  view.setUint16(off, 1, true); off += 2;          // format = PCM
  view.setUint16(off, TARGET_CHANNELS, true); off += 2;
  view.setUint32(off, sampleRate, true); off += 4;
  view.setUint32(off, byteRate, true); off += 4;
  view.setUint16(off, blockAlign, true); off += 2;
  view.setUint16(off, TARGET_BIT_DEPTH, true); off += 2;
  writeStr('data');
  view.setUint32(off, dataSize, true); off += 4;

  return buffer;
}

/**
 * Enumerate available input devices. Labels are only populated after
 * the user has granted mic permission at least once in this origin.
 */
export async function listInputDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs
      .filter(d => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      }));
  } catch {
    return [];
  }
}

export async function listOutputDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs
      .filter(d => d.kind === 'audiooutput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Speaker ${i + 1}`,
      }));
  } catch {
    return [];
  }
}
