/**
 * PodSync PCM capture worklet.
 *
 * Runs on the audio-rendering thread. Forwards raw Float32 samples to
 * the main thread in batches of `BATCH_SAMPLES` so we don't post one
 * message per 128-sample render quantum (thousands of messages per
 * second). Each batch is a plain Float32Array that the main thread
 * converts to int16 and appends to a WAV blob.
 *
 * Intentionally does NO processing (no filters, no gain, no resample).
 * The whole point of PodSync is that each mic is recorded locally at
 * device-native quality. The browser already disables echo cancel /
 * noise suppression / AGC via the getUserMedia constraints we pass -
 * this worklet just forwards what it receives.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~21 ms of audio at 48 kHz. Small enough that the level meter
    // still feels live (~47 Hz update rate), big enough to keep
    // postMessage traffic reasonable.
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
        // Transfer ownership - the main thread takes the underlying
        // memory. We allocate a new buffer immediately to keep the
        // worklet lock-free.
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
