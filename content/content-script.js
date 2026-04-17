/**
 * AudioHD Pro — Content Script
 * ============================================================
 * Injected into every page (all_frames: true).
 * Responsibilities:
 *  1. Detect <video> / <audio> elements dynamically via MutationObserver.
 *  2. Instantiate / lazily init the AudioController singleton.
 *  3. Auto-load site profile settings from background.
 *  4. Handle messages from popup.js (settings changes, visualizer data requests).
 *  5. Listen to keyboard shortcuts.
 *  6. Clean up on page unload (memory management).
 *
 * Loaded AFTER audio-engine.js (declared second in manifest content_scripts).
 *
 * @module ContentScript
 */

'use strict';

// ─── Module State ─────────────────────────────────────────────────────────────

/** Singleton controller reference (lazy-init on first media element) */
let controller = null;

/** Pending media elements waiting for controller init */
const pendingElements = new Set();

/** Pending settings pushed from background before controller init */
let pendingSettings = null;

/** Whether we're currently initializing */
let initializing = false;

/** Track discovered media elements so we can detect playback activity */
const knownMediaElements = new Set();

/** Background port (used for keep-alive + priority system) */
let bgPort = null;
let bgReconnectTimer = null;
let lastActivitySentAt = 0;
let lastPlayingState = false;

// ─── Lazy Initializer ─────────────────────────────────────────────────────────

/**
 * Gets or creates the AudioController, loads site profile, and processes
 * any already-discovered media elements.
 * @returns {Promise<AudioController>}
 */
async function ensureController() {
  if (controller) return controller;
  if (initializing) {
    // Wait for ongoing initialization
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (controller) { clearInterval(check); resolve(controller); }
      }, 50);
    });
  }

  initializing = true;
  controller = getAudioController(); // From audio-engine.js
  await controller.initialize();

  // Load settings for this domain
  await loadSiteSettings();

  // If background pushed settings before init, apply them now.
  if (pendingSettings) {
    controller.applySettings(pendingSettings);
    pendingSettings = null;
  }

  // Process any elements found before init completed
  for (const el of pendingElements) {
    await controller.processMediaElement(el);
  }
  pendingElements.clear();

  initializing = false;
  return controller;
}

// ─── Site Settings Loader ────────────────────────────────────────────────────

/**
 * Requests merged settings (global + site profile) from background
 * and applies them to the controller.
 */
async function loadSiteSettings() {
  if (!controller) return;
  try {
    const hostname = location.hostname;
    const resp = await chrome.runtime.sendMessage({
      type: 'GET_SETTINGS',
      hostname,
    });
    if (resp?.success && resp.settings) {
      controller.applySettings(resp.settings);
    }
  } catch (err) {
    console.warn('[AudioHD Pro] Could not load settings from background:', err);
  }
}

// ─── Media Element Detection ──────────────────────────────────────────────────

/**
 * Handles a newly-discovered media element.
 * @param {HTMLMediaElement} element
 */
async function handleMediaElement(element) {
  if (!element || !(element instanceof HTMLMediaElement)) return;

  // Track and attach lightweight listeners once so we can detect audio activity.
  if (!knownMediaElements.has(element)) {
    knownMediaElements.add(element);

    const onActivity = () => updateMediaActivity();
    element.addEventListener('playing', onActivity, { passive: true });
    element.addEventListener('play', onActivity, { passive: true });
    element.addEventListener('pause', onActivity, { passive: true });
    element.addEventListener('ended', onActivity, { passive: true });
    element.addEventListener('volumechange', onActivity, { passive: true });
    element.addEventListener('emptied', onActivity, { passive: true });
  }

  try {
    if (!controller) {
      // Queue until controller is ready
      pendingElements.add(element);
      await ensureController();
    } else {
      await controller.processMediaElement(element);
    }
  } catch (err) {
    console.warn('[AudioHD Pro] Error handling media element:', err);
  } finally {
    updateMediaActivity();
  }
}

/**
 * Scans the current document for all video/audio elements and processes them.
 */
function scanForMediaElements() {
  const elements = document.querySelectorAll('video, audio');
  elements.forEach(el => handleMediaElement(el));
}

// ─── MutationObserver — Dynamic DOM Detection ────────────────────────────────

/** Observes the document for newly added video/audio elements. */
const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // Direct media element
      if (node instanceof HTMLMediaElement) {
        handleMediaElement(node);
        continue;
      }

      // Subtree contains media elements
      const children = node.querySelectorAll?.('video, audio');
      if (children?.length) {
        children.forEach(el => handleMediaElement(el));
      }
    }
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree:   true,
});

// Initial scan in case elements already exist
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scanForMediaElements);
} else {
  scanForMediaElements();
}

// ─── Message Handling (Popup ↔ Content Script) ───────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    /**
     * APPLY_SETTINGS — sent by background when tab navigates or popup saves.
     */
    case 'APPLY_SETTINGS': {
      if (controller) {
        controller.applySettings(message.settings);
      } else {
        // Store as pending; will be applied in ensureController → loadSiteSettings
        pendingSettings = message.settings;
      }
      sendResponse({ success: true });
      return false;
    }

    /**
     * GET_SETTINGS — popup requesting current active settings.
     */
    /**
     * SET_PRIORITY — sent by background to enforce the "audio emitting tab" priority.
     */
    case 'SET_PRIORITY': {
      controller?.setPriority?.(!!message.priority);
      sendResponse({ success: true });
      return false;
    }

    case 'GET_SETTINGS': {
      const s = controller?.settings ?? null;
      sendResponse({ success: true, settings: s });
      return false;
    }

    /**
     * SET_VOLUME — immediate volume change from popup slider.
     */
    case 'SET_VOLUME': {
      if (controller) controller.applySettings({ volume: message.volume });
      sendResponse({ success: true });
      return false;
    }

    /**
     * SET_EQ — update individual EQ band.
     */
    case 'SET_EQ': {
      if (controller) {
        const bands = [...(controller.settings.eqBands ?? [0,0,0,0,0,0,0,0,0,0])];
        bands[message.band] = message.gain;
        controller.applySettings({ eqBands: bands });
      }
      sendResponse({ success: true });
      return false;
    }

    /**
     * SET_PRESET — apply a named preset to EQ.
     */
    case 'SET_PRESET': {
      if (controller) {
        const eqBands = controller.getPreset(message.preset);
        controller.applySettings({ eqBands, preset: message.preset });
      }
      sendResponse({ success: true });
      return false;
    }

    /**
     * TOGGLE_FEATURE — toggle a boolean feature flag.
     */
    case 'TOGGLE_FEATURE': {
      if (controller) {
        controller.applySettings({ [message.feature]: message.value });
      }
      sendResponse({ success: true });
      return false;
    }

    /**
     * GET_ANALYSER_DATA — popup requesting frequency data for the visualizer.
     */
    case 'GET_ANALYSER_DATA': {
      if (controller) {
        const freq = Array.from(controller.getFrequencyData());
        sendResponse({ success: true, freq });
      } else {
        sendResponse({ success: false, freq: [] });
      }
      return false;
    }

    /**
     * GET_STATUS — popup checking whether audio is active on this tab.
     */
    case 'GET_STATUS': {
      sendResponse({
        success:       true,
        active:        !!controller,
        contextState:  controller?.context?.state ?? 'none',
        elementsCount: controller
          ? document.querySelectorAll('video, audio').length
          : 0,
        settings:      controller?.settings ?? null,
      });
      return false;
    }

    default:
      sendResponse({ success: false, error: `Unknown message: ${message.type}` });
      return false;
  }
});

// ─── Port-based Visualizer Streaming ─────────────────────────────────────────

/**
 * The popup opens a long-lived port named 'visualizer' to poll frequency data
 * without the overhead of repeated sendMessage round-trips.
 */
// â”€â”€â”€ Background Connection + Audio Activity Heartbeat â”€â”€â”€

function connectBackgroundPort() {
  try {
    bgPort = chrome.runtime.connect({ name: 'audiohd' });
    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      if (bgReconnectTimer) return;
      bgReconnectTimer = setTimeout(() => {
        bgReconnectTimer = null;
        connectBackgroundPort();
      }, 1000);
    });

    bgPort.postMessage({ type: 'HELLO', href: location.href });
  } catch (_) {
    bgPort = null;
  }
}

function isElementAudible(el) {
  try {
    return (
      el &&
      !el.paused &&
      !el.ended &&
      el.readyState >= 2 &&
      !el.muted &&
      (el.volume ?? 1) > 0
    );
  } catch (_) {
    return false;
  }
}

function updateMediaActivity() {
  const playing = Array.from(knownMediaElements).some(isElementAudible);

  // Let the engine auto-resume if Chrome suspended the context.
  controller?.setMediaIsPlaying?.(playing);

  const now = Date.now();
  const shouldSend =
    playing !== lastPlayingState ||
    (playing && now - lastActivitySentAt > 900);

  lastPlayingState = playing;
  if (!shouldSend) return;
  lastActivitySentAt = now;

  bgPort?.postMessage({
    type: 'AUDIO_ACTIVITY',
    playing,
    ts: now,
  });
}

connectBackgroundPort();

// While the page is alive, keep sending playback heartbeats so the background can
// keep the correct tab prioritized (and keep the service worker alive).
setInterval(() => updateMediaActivity(), 1000);

// Keep MV3 service worker alive while this tab exists; refresh activity periodically.
setInterval(() => {
  bgPort?.postMessage({ type: 'KEEP_ALIVE', ts: Date.now() });
}, 25000);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'visualizer') return;

  let streamInterval = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'START_STREAM') {
      streamInterval = setInterval(() => {
        if (!controller) {
          port.postMessage({ type: 'FREQ_DATA', freq: [], waveform: [] });
          return;
        }
        port.postMessage({
          type:     'FREQ_DATA',
          freq:     Array.from(controller.getFrequencyData()),
          waveform: Array.from(controller.getWaveformData()),
        });
      }, 50); // 20 fps
    }

    if (msg.type === 'STOP_STREAM') {
      if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
    }
  });

  port.onDisconnect.addListener(() => {
    if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
  });
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', async (e) => {
  if (!controller) return;

  // Only fire if no input/textarea is focused
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  const { shortcuts = {} } = await chrome.storage.sync.get('shortcuts').catch(() => ({}));

  const key = e.code; // e.g. 'ArrowUp', 'KeyE', 'KeyP'

  if (key === (shortcuts.volumeUp ?? 'ArrowUp')) {
    e.preventDefault();
    const vol = Math.min(6.0, (controller.settings.volume ?? 1) + 0.1);
    controller.applySettings({ volume: vol });
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: controller.settings });
  }

  if (key === (shortcuts.volumeDown ?? 'ArrowDown')) {
    e.preventDefault();
    const vol = Math.max(0, (controller.settings.volume ?? 1) - 0.1);
    controller.applySettings({ volume: vol });
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: controller.settings });
  }

  if (key === (shortcuts.toggleEQ ?? 'KeyE')) {
    const enabled = !controller.settings.enabled;
    controller.applySettings({ enabled });
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: controller.settings });
  }

  if (key === (shortcuts.nextPreset ?? 'KeyP')) {
    const presetOrder = ['flat', 'bass', 'vocal', 'cinematic', 'night', 'rock', 'pop'];
    const idx  = presetOrder.indexOf(controller.settings.preset ?? 'flat');
    const next = presetOrder[(idx + 1) % presetOrder.length];
    const eqBands = controller.getPreset(next);
    controller.applySettings({ preset: next, eqBands });
    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: controller.settings });
  }
}, { passive: false });

// ─── Cleanup on Unload ────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  observer.disconnect();
  controller?.destroy();
  controller = null;
});

document.addEventListener('visibilitychange', () => {
  // Do NOT suspend on background; that breaks background playback.
  if (document.visibilityState === 'visible') {
    controller?.context?.resume?.().catch?.(() => {});
  }
});
