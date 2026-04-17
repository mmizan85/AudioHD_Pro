/**
 * AudioHD Pro â€” Audio Engine
 * ============================================================
 * Core Web Audio API processing engine.
 * Loaded as a content script BEFORE content-script.js so that
 * AudioController is available in the same execution context.
 *
 * Architecture (Singleton per tab):
 *
 *   MediaElementSource
 *       â”‚
 *       â–¼
 *   [EQ: 10Ã— BiquadFilterNode]  â†â”€â”€ 10-band graphic EQ
 *       â”‚
 *       â–¼
 *   GainNode (Volume)           â†â”€â”€ 0â€“600% volume booster
 *       â”‚
 *       â–¼
 *   SubBass (BiquadFilter + Gain) â†â”€â”€ Sub-bass enhancer
 *       â”‚
 *       â–¼
 *   WaveShaperNode (Crystalizer) â†â”€â”€ HD harmonic exciter (4Ã— oversample)
 *       â”‚
 *       â–¼
 *   ChannelSplitter â†’ Merger    â†â”€â”€ Vocal Remover / Mono-to-Stereo
 *       â”‚
 *       â–¼
 *   DynamicsCompressorNode      â†â”€â”€ Smart loudness normalization
 *       â”‚
 *       â–¼
 *   PannerNode (HRTF)           â†â”€â”€ 3D Spatial Audio
 *       â”‚
 *       â”œâ”€â”€â–º DryGainNode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 *       â”‚                                       â”‚
 *       â””â”€â”€â–º ConvolverNode â†’ WetGainNode â”€â”€â”€â”€â”€â”€â”€â”¤ Reverb mix
 *                                               â”‚
 *                                               â–¼
 *                                       AudioWorkletNode (PeakLimiter)
 *                                       or ScriptProcessorNode (fallback)
 *                                               â”‚
 *                                               â–¼
 *                                           AnalyserNode
 *                                               â”‚
 *                                               â–¼
 *                                         ctx.destination
 *
 * @module AudioEngine
 */

'use strict';

// â”€â”€â”€ EQ Band Definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @typedef {Object} EQBand
 * @property {number} frequency - Center/corner frequency in Hz.
 * @property {BiquadFilterType} type - Filter type.
 * @property {number} gain - Initial gain in dB.
 * @property {string} label - Human-readable label for UI.
 */

/** @type {EQBand[]} */
const EQ_BANDS = [
  { frequency: 32,    type: 'lowshelf',  gain: 0, label: '32Hz'  },
  { frequency: 64,    type: 'peaking',   gain: 0, label: '64Hz'  },
  { frequency: 125,   type: 'peaking',   gain: 0, label: '125Hz' },
  { frequency: 250,   type: 'peaking',   gain: 0, label: '250Hz' },
  { frequency: 500,   type: 'peaking',   gain: 0, label: '500Hz' },
  { frequency: 1000,  type: 'peaking',   gain: 0, label: '1kHz'  },
  { frequency: 2000,  type: 'peaking',   gain: 0, label: '2kHz'  },
  { frequency: 4000,  type: 'peaking',   gain: 0, label: '4kHz'  },
  { frequency: 8000,  type: 'peaking',   gain: 0, label: '8kHz'  },
  { frequency: 16000, type: 'highshelf', gain: 0, label: '16kHz' },
];

// â”€â”€â”€ Built-in Presets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** @type {Record<string, number[]>} EQ gain arrays per preset (10 values, dB) */
const EQ_PRESETS = {
  flat:      [0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
  bass:      [8,  7,  5,  2,  0, -1, -1,  0,  1,  2],
  vocal:     [-2,-2,  0,  4,  6,  6,  4,  2,  0, -2],
  cinematic: [5,  4,  2,  0, -1,  0,  2,  4,  5,  6],
  night:     [3,  2,  1,  0, -2, -2, -1,  0,  1,  2],
  rock:      [4,  3,  2,  0, -1,  0,  2,  4,  4,  3],
  pop:       [1,  2,  3,  2,  0, -1,  2,  3,  3,  2],
};

// â”€â”€â”€ AudioController Singleton â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * @class AudioController
 * @description Manages the entire Web Audio pipeline. Singleton per tab.
 */
class AudioController {
  constructor() {
    // â”€â”€ Singleton guard â”€â”€
    if (AudioController._instance) return AudioController._instance;
    AudioController._instance = this;

    // â”€â”€ AudioContext â”€â”€
    /** @type {AudioContext|null} */
    this.context = null;

    // â”€â”€ Node References â”€â”€
    /** @type {BiquadFilterNode[]} 10-band equalizer filters */
    this.eqFilters = [];

    /** @type {GainNode|null} Master volume (0â€“6) */
    this.gainNode = null;

    /** @type {BiquadFilterNode|null} Sub-bass shelf filter */
    this.subBassFilter = null;

    /** @type {GainNode|null} Sub-bass gain makeup */
    this.subBassGain = null;

    /** @type {WaveShaperNode|null} HD Crystalizer / harmonic exciter */
    this.crystalizerNode = null;

    /** @type {ChannelSplitterNode|null} For vocal remover / mono-to-stereo */
    this.splitterNode = null;

    /** @type {ChannelMergerNode|null} */
    this.mergerNode = null;

    /** @type {GainNode|null} Vocal-remover phase-inversion gain (âˆ’1) */
    this._invertGain = null;

    /** @type {DynamicsCompressorNode|null} */
    this.compressorNode = null;

    /** @type {PannerNode|null} 3D spatial audio */
    this.pannerNode = null;

    /** @type {ConvolverNode|null} Reverb impulse-response */
    this.convolverNode = null;

    /** @type {GainNode|null} Dry signal mix */
    this.dryGain = null;

    /** @type {GainNode|null} Wet (reverb) signal mix */
    this.wetGain = null;

    /** @type {AudioWorkletNode|null} Peak limiter (preferred) */
    this.limiterWorklet = null;

    /** @type {ScriptProcessorNode|null} Peak limiter fallback */
    this.limiterFallback = null;

    /** @type {AnalyserNode|null} Frequency analyser for visualizer */
    this.analyserNode = null;

    /** @type {GainNode|null} Input bus fed by all media sources */
    this.inputBus = null;

    /** @type {GainNode|null} Direct (bypass) path gain */
    this.bypassGain = null;

    /** @type {GainNode|null} Processed path gain (post-FX, pre-limiter/analyser) */
    this.processedGain = null;

    // â”€â”€ State â”€â”€
    /** @type {WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>} */
    this.processedElements = new WeakMap();

    /** @type {boolean} */
    this.workletSupported = false;

    /** @type {boolean} */
    this.initialized = false;

    /** @type {Object} Active settings */
    this.settings = this._defaultSettings();

    /** @type {number|null} Debug interval ID */
    this._debugInterval = null;

    /** @type {boolean} Whether this tab currently has processing priority */
    this._hasPriority = true;

    /** @type {boolean} Whether any attached media is currently playing */
    this._isMediaPlaying = false;

    /** @type {boolean} Internal: whether the processed chain input is connected */
    this._processedConnected = false;
  }

  // â”€â”€ Defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** @returns {Object} Factory-default settings object */
  _defaultSettings() {
    return {
      enabled: true,
      volume: 1.0,
      eqBands: EQ_BANDS.map(b => b.gain),
      compressor: { enabled: true, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
      spatial:    { enabled: false, panX: 0, panY: 0, panZ: 1 },
      reverb:     { enabled: false, wetness: 0.3, roomSize: 'medium' },
      subBassEnhancer: false,
      hdCrystalizer:   false,
      monoToStereo:    false,
      vocalRemover:    false,
      preset: 'flat',
      debugMode: false,
    };
  }

  // â”€â”€ Initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Creates the AudioContext, loads AudioWorklet, and builds the audio graph.
   * Idempotent â€” safe to call multiple times.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized && this.context?.state !== 'closed') return;

    this.context = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate:  48000,
    });

    // Resume context after user gesture (browser autoplay policy)
    this._resumeOnInteraction();

    // If Chrome suspends the AudioContext while media is playing, try to resume.
    this.context.onstatechange = () => {
      if (!this.context) return;
      if (this.context.state === 'suspended' && this._isMediaPlaying) {
        this.context.resume().catch(() => {});
      }
    };

    // Try to load AudioWorklet for the peak limiter
    try {
      const workletUrl = chrome.runtime.getURL('audio/worklet-processor.js');
      await this.context.audioWorklet.addModule(workletUrl);
      this.workletSupported = true;
      this._log('AudioWorklet loaded âœ“');
    } catch (err) {
      this._log('AudioWorklet unavailable â€” using ScriptProcessor fallback', 'warn', err);
      this.workletSupported = false;
    }

    this._buildAudioGraph();
    this._applySettings(this.settings);
    this.initialized = true;
  }

  // â”€â”€ Audio Graph Construction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Instantiates and connects all audio nodes in the processing chain.
   * @private
   */
  _buildAudioGraph() {
    const ctx = this.context;

    // Input + bypass/processed router:
    // - All media sources feed `inputBus`
    // - Bypass path:  inputBus -> bypassGain -> destination
    // - Process path: inputBus -> FX chain -> processedGain -> limiter/analyser -> destination
    this.inputBus = ctx.createGain();
    this.inputBus.gain.value = 1.0;

    this.bypassGain = ctx.createGain();
    this.bypassGain.gain.value = 0.0;

    this.processedGain = ctx.createGain();
    this.processedGain.gain.value = 1.0;

    // â”€â”€ 10-Band EQ â”€â”€
    this.eqFilters = EQ_BANDS.map(band => {
      const f = ctx.createBiquadFilter();
      f.type             = band.type;
      f.frequency.value  = band.frequency;
      f.Q.value          = 1.4;  // Moderate bandwidth per band
      f.gain.value       = 0;
      return f;
    });
    // Chain EQ filters in series
    for (let i = 0; i < this.eqFilters.length - 1; i++) {
      this.eqFilters[i].connect(this.eqFilters[i + 1]);
    }

    // â”€â”€ Volume GainNode (up to Ã—6 = 600%) â”€â”€
    this.gainNode            = ctx.createGain();
    this.gainNode.gain.value = 1.0;

    // â”€â”€ Sub-Bass Enhancer â”€â”€
    this.subBassFilter            = ctx.createBiquadFilter();
    this.subBassFilter.type       = 'lowshelf';
    this.subBassFilter.frequency.value = 80;
    this.subBassFilter.gain.value = 0;

    this.subBassGain            = ctx.createGain();
    this.subBassGain.gain.value = 1.0;

    // â”€â”€ HD Crystalizer (WaveShaper â€” 4Ã— oversample for anti-aliasing) â”€â”€
    this.crystalizerNode             = ctx.createWaveShaper();
    this.crystalizerNode.curve       = this._crystalizerCurve(0);
    this.crystalizerNode.oversample  = '4x';

    // â”€â”€ Channel Splitter / Merger (Vocal Remover, Monoâ†’Stereo) â”€â”€
    this.splitterNode = ctx.createChannelSplitter(2);
    this.mergerNode   = ctx.createChannelMerger(2);
    this._invertGain  = ctx.createGain();
    this._invertGain.gain.value = -1; // Used only for vocal remover mode

    // Default stereo passthrough
    this.splitterNode.connect(this.mergerNode, 0, 0);
    this.splitterNode.connect(this.mergerNode, 1, 1);

    // â”€â”€ Dynamics Compressor â”€â”€
    this.compressorNode            = ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;
    this.compressorNode.knee.value       = 30;
    this.compressorNode.ratio.value      = 12;
    this.compressorNode.attack.value     = 0.003;
    this.compressorNode.release.value    = 0.25;

    // â”€â”€ 3D Spatial Audio Panner (HRTF) â”€â”€
    this.pannerNode               = ctx.createPanner();
    this.pannerNode.panningModel  = 'HRTF';
    this.pannerNode.distanceModel = 'inverse';
    this.pannerNode.setPosition(0, 0, 1);

    // â”€â”€ Reverb (ConvolverNode) with Dry/Wet Mix â”€â”€
    this.convolverNode = ctx.createConvolver();
    this.dryGain       = ctx.createGain();
    this.wetGain       = ctx.createGain();
    this.dryGain.gain.value = 1.0;
    this.wetGain.gain.value = 0.0;
    this._generateImpulseResponse('medium');

    // â”€â”€ Peak Limiter (AudioWorklet preferred, ScriptProcessor fallback) â”€â”€
    if (this.workletSupported) {
      this.limiterWorklet = new AudioWorkletNode(ctx, 'peak-limiter', {
        numberOfInputs:    1,
        numberOfOutputs:   1,
        outputChannelCount:[2],
      });
      // Listen for peak level reports from the worklet thread
      this.limiterWorklet.port.onmessage = (e) => {
        if (e.data?.peak !== undefined) this._lastPeak = e.data.peak;
      };
    } else {
      this._createScriptProcessorLimiter();
    }

    // â”€â”€ Analyser Node (feeds the popup visualizer) â”€â”€
    this.analyserNode                       = ctx.createAnalyser();
    this.analyserNode.fftSize               = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // â”€â”€ Wire the Graph â”€â”€
    const eqHead   = this.eqFilters[0];
    const eqTail   = this.eqFilters[this.eqFilters.length - 1];
    const limiter  = this.limiterWorklet || this.limiterFallback;

    // Bypass path goes straight to speakers.
    this.inputBus.connect(this.bypassGain);
    this.bypassGain.connect(ctx.destination);

    // Processed path (we connect/disconnect inputBus -> EQ head dynamically for bypass/priority).

    eqTail.connect(this.gainNode);
    this.gainNode.connect(this.subBassFilter);
    this.subBassFilter.connect(this.subBassGain);
    this.subBassGain.connect(this.crystalizerNode);
    this.crystalizerNode.connect(this.splitterNode);
    // (splitterâ†’merger wired above in stereo passthrough mode)
    this.mergerNode.connect(this.compressorNode);
    this.compressorNode.connect(this.pannerNode);
    this.pannerNode.connect(this.dryGain);
    this.pannerNode.connect(this.convolverNode);
    this.convolverNode.connect(this.wetGain);
    this.dryGain.connect(this.processedGain);
    this.wetGain.connect(this.processedGain);
    this.processedGain.connect(limiter);
    limiter.connect(this.analyserNode);
    this.analyserNode.connect(ctx.destination);

    // Default: processed chain enabled.
    this._setProcessedConnected(true);

    this._log('Audio graph built âœ“');
  }

  // â”€â”€ Media Element Processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Internal: connects/disconnects the processed chain input (inputBus -> EQ head).
   * This avoids burning CPU when we're bypassed or not the priority tab.
   * @param {boolean} shouldConnect
   * @private
   */
  _setProcessedConnected(shouldConnect) {
    if (!this.inputBus || !this.eqFilters?.length) return;
    const head = this.eqFilters[0];

    if (shouldConnect && !this._processedConnected) {
      try { this.inputBus.connect(head); } catch (_) {}
      this._processedConnected = true;
      return;
    }

    if (!shouldConnect && this._processedConnected) {
      try { this.inputBus.disconnect(head); } catch (_) {}
      this._processedConnected = false;
    }
  }

  /**
   * Connects a <video> or <audio> element to the shared input bus.
   *
   * CORS note:
   * Some cross-origin media will become silent when routed through WebAudio unless
   * the server provides appropriate CORS headers. We avoid breaking playback by
   * skipping obvious cross-origin URLs unless the element already opted into a CORS mode.
   *
   * @param {HTMLMediaElement} element
   * @returns {Promise<void>}
   */
  async processMediaElement(element) {
    if (this.processedElements.has(element)) return;
    if (!this.initialized) await this.initialize();

    // If the user just started playback and autoplay policy suspended us, try to resume.
    if (this.context?.state === 'suspended') {
      await this.context.resume().catch(() => {});
    }

    // Heuristic: avoid routing obvious cross-origin http(s) media without an explicit CORS mode.
    const src = element.currentSrc || element.src || '';
    try {
      if (src) {
        const u = new URL(src, location.href);
        const isHttp = u.protocol === 'http:' || u.protocol === 'https:';
        const isCrossOrigin = isHttp && u.origin !== location.origin;
        const hasCorsMode = !!element.crossOrigin; // 'anonymous' or 'use-credentials'
        if (isCrossOrigin && !hasCorsMode) {
          this._log(`Skipping cross-origin media without CORS: ${u.origin}`, 'warn');
          return;
        }
      }
    } catch (_) {}

    let source;
    try {
      source = this.context.createMediaElementSource(element);
    } catch (err) {
      if (err?.message?.includes('already connected')) {
        this._log('Element already processed — skipping');
        return;
      }
      this._log('Could not attach element (skipping)', 'warn', err);
      return;
    }

    source.connect(this.inputBus);
    this.processedElements.set(element, source);
    this._log(`Element connected: ${element.tagName} src=${(element.currentSrc || '').slice(0, 80)}`);
  }

  // â”€â”€ Settings API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Merges and applies new settings to all audio nodes.
   * @param {Partial<Object>} settings
   */
  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    if (this.initialized) this._applySettings(this.settings);
  }

  /**
   * Internal: pushes settings values onto audio nodes.
   * @param {Object} s
   * @private
   */
  _applySettings(s) {
    if (!this.context) return;
    const t = this.context.currentTime;

    // Master enable / bypass routing:
    // enabled=false OR not-priority => bypass (source -> destination)
    const effectiveEnabled = !!s.enabled && this._hasPriority;
    const vol = Math.min(6.0, Math.max(0, s.volume ?? 1));

    // Crossfade between bypass and processed to avoid clicks.
    this.bypassGain.gain.setTargetAtTime(effectiveEnabled ? 0 : 1, t, 0.01);
    this.processedGain.gain.setTargetAtTime(effectiveEnabled ? 1 : 0, t, 0.01);
    this._setProcessedConnected(effectiveEnabled);

    // Volume applies only to processed path (bypass should be "normal playback").
    this.gainNode.gain.setTargetAtTime(vol, t, 0.015);

    // â”€â”€ 10-Band EQ â”€â”€
    if (Array.isArray(s.eqBands)) {
      s.eqBands.forEach((gain, i) => {
        if (this.eqFilters[i]) {
          this.eqFilters[i].gain.setTargetAtTime(
            Math.min(15, Math.max(-15, gain)), t, 0.01
          );
        }
      });
    }

    // â”€â”€ Sub-Bass Enhancer â”€â”€
    this.subBassFilter.gain.setTargetAtTime(
      s.subBassEnhancer ? 10 : 0, t, 0.05
    );

    // â”€â”€ HD Crystalizer â”€â”€
    this.crystalizerNode.curve = this._crystalizerCurve(s.hdCrystalizer ? 0.45 : 0);

    // â”€â”€ Vocal Remover / Monoâ†’Stereo â”€â”€
    this._configureChannelProcessing(s.vocalRemover, s.monoToStereo);

    // â”€â”€ Dynamics Compressor â”€â”€
    if (s.compressor) {
      this.compressorNode.threshold.value = s.compressor.threshold ?? -24;
      this.compressorNode.knee.value      = s.compressor.knee      ?? 30;
      this.compressorNode.ratio.value     = s.compressor.ratio     ?? 12;
      this.compressorNode.attack.value    = s.compressor.attack    ?? 0.003;
      this.compressorNode.release.value   = s.compressor.release   ?? 0.25;
    }

    // â”€â”€ 3D Spatial Panner â”€â”€
    if (s.spatial?.enabled) {
      this.pannerNode.setPosition(
        s.spatial.panX ?? 0,
        s.spatial.panY ?? 0,
        s.spatial.panZ ?? 1
      );
    } else {
      this.pannerNode.setPosition(0, 0, 1);
    }

    // â”€â”€ Reverb Dry/Wet Mix â”€â”€
    if (s.reverb) {
      const wet = s.reverb.enabled ? Math.min(1, Math.max(0, s.reverb.wetness ?? 0.3)) : 0;
      this.wetGain.gain.setTargetAtTime(wet,       t, 0.05);
      this.dryGain.gain.setTargetAtTime(1 - wet * 0.5, t, 0.05);
      if (s.reverb.roomSize) this._generateImpulseResponse(s.reverb.roomSize);
    }

    // â”€â”€ Worklet Limiter threshold â”€â”€
    if (this.limiterWorklet) {
      this.limiterWorklet.port.postMessage({ threshold: 0.95 });
    }

    // â”€â”€ Debug mode â”€â”€
    if (s.debugMode) {
      if (!this._debugInterval) this._startDebugLogging();
    } else {
      if (this._debugInterval) {
        clearInterval(this._debugInterval);
        this._debugInterval = null;
      }
    }
  }

  /**
   * Background "priority system" hook.
   * When this tab is not priority, we automatically bypass to keep audio playing normally.
   * @param {boolean} hasPriority
   */
  setPriority(hasPriority) {
    this._hasPriority = !!hasPriority;
    if (this.initialized) this._applySettings(this.settings);
  }

  /**
   * Lets the content script tell us whether any media is currently playing.
   * Used to auto-resume the AudioContext if Chrome suspends it.
   * @param {boolean} isPlaying
   */
  setMediaIsPlaying(isPlaying) {
    this._isMediaPlaying = !!isPlaying;
    if (this.context?.state === 'suspended' && this._isMediaPlaying) {
      this.context.resume().catch(() => {});
    }
  }

  // â”€â”€ Preset Loader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Returns EQ gain array for a named preset.
   * @param {string} name
   * @returns {number[]}
   */
  getPreset(name) {
    return EQ_PRESETS[name] ?? EQ_PRESETS.flat;
  }

  // â”€â”€ Visualizer Data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Snapshot of frequency-domain data for the visualizer (0â€“255 per bin).
   * @returns {Uint8Array}
   */
  getFrequencyData() {
    if (!this.analyserNode) return new Uint8Array(0);
    const buf = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(buf);
    return buf;
  }

  /**
   * Snapshot of time-domain waveform data for oscilloscope view.
   * @returns {Uint8Array}
   */
  getWaveformData() {
    if (!this.analyserNode) return new Uint8Array(0);
    const buf = new Uint8Array(this.analyserNode.fftSize);
    this.analyserNode.getByteTimeDomainData(buf);
    return buf;
  }

  // â”€â”€ Private Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Configures splitterâ†’merger routing for vocal remover or mono-to-stereo.
   * @param {boolean} vocalRemover
   * @param {boolean} monoToStereo
   * @private
   */
  _configureChannelProcessing(vocalRemover, monoToStereo) {
    try { this.splitterNode.disconnect(); } catch (_) {}
    try { this._invertGain.disconnect(); } catch (_) {}

    if (vocalRemover) {
      // Phase inversion on L channel â†’ subtract from R â†’ removes centre-panned content (vocals)
      this.splitterNode.connect(this._invertGain, 0);
      this._invertGain.connect(this.mergerNode, 0, 0);
      this.splitterNode.connect(this.mergerNode, 1, 1);
    } else if (monoToStereo) {
      // Sum L+R into both output channels for mono upmix
      this.splitterNode.connect(this.mergerNode, 0, 0);
      this.splitterNode.connect(this.mergerNode, 0, 1);
    } else {
      // Default: transparent stereo passthrough
      this.splitterNode.connect(this.mergerNode, 0, 0);
      this.splitterNode.connect(this.mergerNode, 1, 1);
    }
  }

  /**
   * Builds a WaveShaper curve for the HD Crystalizer (harmonic exciter).
   * At amount=0 the curve is linear (bypass); higher values add soft saturation.
   * The WaveShaperNode oversample='4x' provides anti-aliasing.
   *
   * @param {number} amount - Enhancement intensity (0â€“1).
   * @returns {Float32Array}
   * @private
   */
  _crystalizerCurve(amount) {
    const n     = 512;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1; // Map to [-1, 1]
      // Soft-knee saturation: linear base + subtle tanh harmonic addition
      curve[i] = amount === 0
        ? x
        : x + amount * Math.tanh(x * 2.5) * 0.2;
    }
    return curve;
  }

  /**
   * Generates a synthetic impulse response for the ConvolverNode reverb.
   * @param {'small'|'medium'|'large'} size - Conceptual room size.
   * @private
   */
  _generateImpulseResponse(size) {
    if (!this.context || !this.convolverNode) return;
    const sr       = this.context.sampleRate;
    const dur      = { small: 0.5, medium: 1.5, large: 3.0 }[size] ?? 1.5;
    const decay    = { small: 1.5, medium: 2.5, large: 3.5 }[size] ?? 2.5;
    const length   = Math.floor(sr * dur);
    const impulse  = this.context.createBuffer(2, length, sr);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    this.convolverNode.buffer = impulse;
  }

  /**
   * Creates a ScriptProcessorNode peak limiter as a fallback for environments
   * where AudioWorklet is unavailable.
   * @private
   */
  _createScriptProcessorLimiter() {
    const ctx         = this.context;
    const bufSize     = 4096;
    const processor   = ctx.createScriptProcessor(bufSize, 2, 2);
    const threshold   = 0.95;
    let   envelope    = 0;
    const sr          = ctx.sampleRate;
    const attackCoeff = Math.exp(-1 / (sr * 0.003));
    const relCoeff    = Math.exp(-1 / (sr * 0.1));

    processor.onaudioprocess = (e) => {
      for (let ch = 0; ch < e.inputBuffer.numberOfChannels; ch++) {
        const inp = e.inputBuffer.getChannelData(ch);
        const out = e.outputBuffer.getChannelData(ch);
        for (let i = 0; i < inp.length; i++) {
          const abs = Math.abs(inp[i]);
          envelope  = abs > envelope
            ? attackCoeff * envelope + (1 - attackCoeff) * abs
            : relCoeff    * envelope + (1 - relCoeff)    * abs;
          const gain = envelope > threshold ? threshold / envelope : 1.0;
          out[i] = inp[i] * gain;
        }
      }
    };

    this.limiterFallback = processor;
  }

  /** Auto-resume the AudioContext when the user interacts with the page. @private */
  _resumeOnInteraction() {
    if (this.context.state !== 'suspended') return;
    const resume = () => {
      this.context?.resume();
      document.removeEventListener('click',   resume, true);
      document.removeEventListener('keydown', resume, true);
      document.removeEventListener('touchend',resume, true);
    };
    document.addEventListener('click',    resume, true);
    document.addEventListener('keydown',  resume, true);
    document.addEventListener('touchend', resume, true);
  }

  /** Periodic debug logging (only in debugMode). @private */
  _startDebugLogging() {
    const buf = new Float32Array(this.analyserNode?.frequencyBinCount ?? 1024);
    this._debugInterval = setInterval(() => {
      if (!this.analyserNode) return;
      this.analyserNode.getFloatFrequencyData(buf);
      let peak = -Infinity;
      for (const v of buf) if (v > peak) peak = v;
      console.log(
        `[AudioHD Pro Debug] state=${this.context?.state} ` +
        `gain=${this.gainNode?.gain.value.toFixed(2)} ` +
        `compRed=${this.compressorNode?.reduction?.toFixed(2) ?? 'n/a'} dB ` +
        `peak=${peak.toFixed(1)} dBFS`
      );
    }, 2000);
  }

  /** @private */
  _log(msg, level = 'log', err = null) {
    if (!this.settings?.debugMode && level === 'log') return;
    const prefix = '[AudioHD Pro]';
    if (level === 'error') console.error(prefix, msg, err ?? '');
    else if (level === 'warn') console.warn(prefix, msg, err ?? '');
    else console.log(prefix, msg);
  }

  // â”€â”€ Teardown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Closes the AudioContext and disconnects all nodes.
   * Call on page unload to prevent memory leaks.
   */
  destroy() {
    if (!this.context) return;

    const allNodes = [
      ...this.eqFilters,
      this.inputBus, this.bypassGain, this.processedGain,
      this.gainNode, this.subBassFilter, this.subBassGain,
      this.crystalizerNode, this.splitterNode, this.mergerNode, this._invertGain,
      this.compressorNode, this.pannerNode, this.convolverNode,
      this.dryGain, this.wetGain,
      this.limiterWorklet, this.limiterFallback,
      this.analyserNode,
    ];

    allNodes.forEach(node => { if (node) try { node.disconnect(); } catch(_) {} });

    if (this._debugInterval) clearInterval(this._debugInterval);

    this.context.close().then(() => {
      this.context   = null;
      this.initialized = false;
      AudioController._instance = null;
      console.log('[AudioHD Pro] AudioContext destroyed and cleaned up.');
    });
  }
}

/** @type {AudioController|null} */
AudioController._instance = null;

/**
 * Returns the tab-scoped singleton AudioController.
 * Creates it on first call.
 * @returns {AudioController}
 */
function getAudioController() {
  if (!AudioController._instance) new AudioController();
  return AudioController._instance;
}

// Expose EQ_BANDS and EQ_PRESETS for UI use
window.__AudioHDPro = { EQ_BANDS, EQ_PRESETS, getAudioController };

