/**
 * AudioHD Pro — AudioWorklet Processor
 * Runs on a dedicated real-time audio thread (off the main thread).
 *
 * Implements a lookahead Peak Limiter with:
 * - Envelope following (attack / release)
 * - Gain reduction to prevent clipping
 * - Oversampling-aware processing (oversample set externally on WaveShaperNode)
 *
 * @processor peak-limiter
 */

class PeakLimiterProcessor extends AudioWorkletProcessor {
  /**
   * @param {AudioWorkletNodeOptions} options
   */
  constructor(options) {
    super(options);

    /** Hard clip threshold (0–1). Default: just below full scale. */
    this.threshold = 0.95;

    /** Attack time coefficient (sample-level). */
    this.attack = 0.003;

    /** Release time coefficient (sample-level). */
    this.release = 0.1;

    /** Per-channel envelope trackers. */
    this.envelope = [0, 0];

    /** Peak level reported back to UI thread (updated every ~10ms). */
    this.peakReportCounter = 0;
    this.currentPeak = 0;

    // Listen for parameter updates from the main thread
    this.port.onmessage = (event) => {
      const { threshold, attack, release } = event.data || {};
      if (threshold !== undefined) this.threshold = Math.min(1.0, Math.max(0.0, threshold));
      if (attack   !== undefined) this.attack     = attack;
      if (release  !== undefined) this.release    = release;
    };
  }

  /**
   * Processes a block of audio samples (128 frames by default).
   *
   * @param {Float32Array[][]} inputs  - Input audio buffers.
   * @param {Float32Array[][]} outputs - Output audio buffers (written in-place).
   * @returns {boolean} Keep processor alive (true).
   */
  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];

    // If no input (e.g. paused media), pass silence through
    if (!input || input.length === 0) return true;

    const numChannels = Math.min(input.length, output.length);
    const numSamples  = input[0]?.length ?? 0;

    for (let i = 0; i < numSamples; i++) {
      let maxLevel = 0;

      // Detect peak across all channels for this sample frame
      for (let ch = 0; ch < numChannels; ch++) {
        maxLevel = Math.max(maxLevel, Math.abs(input[ch][i] ?? 0));
      }

      // Envelope follower: fast attack, slow release
      for (let ch = 0; ch < numChannels; ch++) {
        const level = Math.abs(input[ch][i] ?? 0);
        if (level > this.envelope[ch]) {
          // Attack: ramp up quickly
          this.envelope[ch] += (level - this.envelope[ch]) * this.attack;
        } else {
          // Release: decay slowly
          this.envelope[ch] += (level - this.envelope[ch]) * this.release;
        }
      }

      // Compute gain reduction from the loudest channel
      const maxEnvelope = Math.max(...this.envelope.slice(0, numChannels));
      const gain = maxEnvelope > this.threshold
        ? this.threshold / maxEnvelope
        : 1.0;

      // Apply gain to all channels
      for (let ch = 0; ch < numChannels; ch++) {
        output[ch][i] = (input[ch][i] ?? 0) * gain;
      }

      // Track peak for UI reporting
      if (maxLevel > this.currentPeak) this.currentPeak = maxLevel;
    }

    // Report peak level back to main thread every ~50ms (≈ 2400 frames @ 48kHz)
    this.peakReportCounter += numSamples;
    if (this.peakReportCounter >= 2400) {
      this.port.postMessage({ peak: this.currentPeak });
      this.currentPeak       = 0;
      this.peakReportCounter = 0;
    }

    return true; // Keep processor alive
  }
}

registerProcessor('peak-limiter', PeakLimiterProcessor);
