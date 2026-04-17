/**
 * AudioHD Pro — Background Service Worker
 * Handles tab lifecycle events, settings storage, message routing,
 * and site profile auto-loading.
 *
 * @module ServiceWorker
 */

'use strict';

// ─── Default Settings ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  volume: 1.0,
  eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  compressor: {
    enabled: true,
    threshold: -24,
    knee: 30,
    ratio: 12,
    attack: 0.003,
    release: 0.25,
  },
  spatial: { enabled: false, panX: 0, panY: 0, panZ: 1 },
  reverb: { enabled: false, wetness: 0.3, roomSize: 'medium' },
  subBassEnhancer: false,
  hdCrystalizer: false,
  monoToStereo: false,
  vocalRemover: false,
  preset: 'flat',
  debugMode: false,
};

// â”€â”€â”€ Priority System (Tab Audio Activity) â”€â”€â”€
// Content scripts open a long-lived port named "audiohd" and send AUDIO_ACTIVITY heartbeats.
// We pick the most recently active "playing" tab as the priority tab and tell all tabs whether
// they have priority via a normal tabs.sendMessage({type:'SET_PRIORITY'}).

const PRIORITY_TIMEOUT_MS = 3500;

/** @type {Map<number, {port: chrome.runtime.Port, lastActivity: number, playing: boolean}>} */
const tabActivity = new Map();

/** @type {number|null} */
let priorityTabId = null;

function recomputePriority() {
  const now = Date.now();
  let bestTabId = null;
  let bestTs = -1;

  for (const [tabId, info] of tabActivity.entries()) {
    const fresh = info.playing && (now - info.lastActivity) < PRIORITY_TIMEOUT_MS;
    if (!fresh) continue;
    if (info.lastActivity > bestTs) {
      bestTs = info.lastActivity;
      bestTabId = tabId;
    }
  }

  // If nothing is actively playing, allow all tabs to be "priority=true".
  const nextPriority = bestTabId ?? null;
  if (nextPriority === priorityTabId) return;
  priorityTabId = nextPriority;

  for (const tabId of tabActivity.keys()) {
    const hasPriority = priorityTabId ? tabId === priorityTabId : true;
    chrome.tabs.sendMessage(tabId, { type: 'SET_PRIORITY', priority: hasPriority }).catch(() => {});
  }
}

// ─── Installation ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // Write defaults to storage on first install
    await chrome.storage.sync.set({
      globalSettings: DEFAULT_SETTINGS,
      siteProfiles: {},
      shortcuts: {
        volumeUp:    'ArrowUp',
        volumeDown:  'ArrowDown',
        toggleEQ:    'KeyE',
        nextPreset:  'KeyP',
      },
    });
    console.log('[AudioHD Pro] Extension installed. Default settings written.');
  }
});

// ─── Message Router ───────────────────────────────────────────────────────────

// Content script ports (keep-alive + activity)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'audiohd') return;

  const tabId = port.sender?.tab?.id;
  if (tabId === undefined || tabId === null) return;

  tabActivity.set(tabId, {
    port,
    lastActivity: Date.now(),
    playing: false,
  });

  port.onMessage.addListener((msg) => {
    const info = tabActivity.get(tabId);
    if (!info) return;

    if (msg?.type === 'AUDIO_ACTIVITY') {
      info.playing = !!msg.playing;
      info.lastActivity = Date.now();
      recomputePriority();
      return;
    }

    if (msg?.type === 'KEEP_ALIVE' || msg?.type === 'HELLO') {
      info.lastActivity = Date.now();
      recomputePriority();
    }
  });

  port.onDisconnect.addListener(() => {
    tabActivity.delete(tabId);
    if (priorityTabId === tabId) priorityTabId = null;
    recomputePriority();
  });

  recomputePriority();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabActivity.delete(tabId);
  if (priorityTabId === tabId) priorityTabId = null;
  recomputePriority();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    /**
     * GET_SETTINGS: Returns merged settings (global + site profile if exists).
     * Sent by: popup.js, content-script.js
     */
    case 'GET_SETTINGS': {
      (async () => {
        try {
          const { globalSettings = DEFAULT_SETTINGS, siteProfiles = {} } =
            await chrome.storage.sync.get(['globalSettings', 'siteProfiles']);

          const hostname = message.hostname || '';
          const profile  = siteProfiles[hostname];
          const settings = profile ? { ...globalSettings, ...profile } : globalSettings;

          sendResponse({ success: true, settings });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // Keep channel open for async response
    }

    /**
     * SAVE_SETTINGS: Persists global settings.
     * Sent by: popup.js, options.js
     */
    case 'SAVE_SETTINGS': {
      (async () => {
        try {
          await chrome.storage.sync.set({ globalSettings: message.settings });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    /**
     * SAVE_SITE_PROFILE: Saves settings for a specific domain.
     * Sent by: popup.js, options.js
     */
    case 'SAVE_SITE_PROFILE': {
      (async () => {
        try {
          const { siteProfiles = {} } = await chrome.storage.sync.get('siteProfiles');
          siteProfiles[message.hostname] = message.settings;
          await chrome.storage.sync.set({ siteProfiles });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    /**
     * DELETE_SITE_PROFILE: Removes a stored domain profile.
     * Sent by: options.js
     */
    case 'DELETE_SITE_PROFILE': {
      (async () => {
        try {
          const { siteProfiles = {} } = await chrome.storage.sync.get('siteProfiles');
          delete siteProfiles[message.hostname];
          await chrome.storage.sync.set({ siteProfiles });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    /**
     * GET_ALL_PROFILES: Returns all saved site profiles.
     * Sent by: options.js
     */
    case 'GET_ALL_PROFILES': {
      (async () => {
        try {
          const { siteProfiles = {} } = await chrome.storage.sync.get('siteProfiles');
          sendResponse({ success: true, siteProfiles });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    /**
     * RELAY_TO_TAB: Forwards a message to the active tab's content script.
     * Used by popup when it can't directly message due to tab restrictions.
     */
    case 'RELAY_TO_TAB': {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) { sendResponse({ success: false, error: 'No active tab' }); return; }
          const resp = await chrome.tabs.sendMessage(tab.id, message.payload);
          sendResponse({ success: true, data: resp });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    default:
      sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
  }
});

// ─── Tab Navigation — Auto-load Site Profiles ─────────────────────────────────

/**
 * When the user navigates to a new URL, notify the content script
 * to reload the matching site profile (if any).
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  try {
    const url      = new URL(tab.url);
    const hostname = url.hostname;

    const { siteProfiles = {}, globalSettings = DEFAULT_SETTINGS } =
      await chrome.storage.sync.get(['siteProfiles', 'globalSettings']);

    const profile  = siteProfiles[hostname];
    const settings = profile ? { ...globalSettings, ...profile } : globalSettings;

    // Notify content script of new settings
    await chrome.tabs.sendMessage(tabId, {
      type:     'APPLY_SETTINGS',
      settings,
      hostname,
    }).catch(() => {}); // Ignore "no receiver" errors for non-injectable pages

  } catch (_) { /* Invalid URL or restricted page — silently ignore */ }
});
