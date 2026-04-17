/**
 * AudioHD Pro — Popup Script
 * ============================================================
 * Controls the popup UI:
 *  - Loads current settings from content script
 *  - Handles all control interactions (volume, EQ, presets, toggles)
 *  - Streams visualizer data from content script via a persistent port
 *  - Saves settings to background storage
 *
 * @module PopupScript
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let activeTab    = null;
let settings     = null;
let visPort      = null;
let visRAF       = null;
let freqData     = new Uint8Array(1024).fill(0);
let waveData     = new Uint8Array(2048).fill(128);

const EQ_LABELS  = ['32Hz','64Hz','125Hz','250Hz','500Hz','1kHz','2kHz','4kHz','8kHz','16kHz'];

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const enableToggle  = $('enableToggle');
const volumeSlider  = $('volumeSlider');
const volumeValue   = $('volumeValue');
const siteLabel     = $('siteLabel');
const eqBandsEl     = $('eqBands');
const presetPills   = $('presetPills');
const eqResetBtn    = $('eqResetBtn');
const saveSiteBtn   = $('saveSiteBtn');
const optionsLink   = $('optionsLink');
const canvas        = $('visualizer');
const ctx2d         = canvas.getContext('2d');

// Effect toggle map: element-id → settings key
const FX_MAP = {
  fxCompressor:   { key: 'compressor',     nested: true,  nestedKey: 'enabled' },
  fxSubBass:      { key: 'subBassEnhancer' },
  fxCrystalizer:  { key: 'hdCrystalizer'   },
  fxReverb:       { key: 'reverb',          nested: true,  nestedKey: 'enabled' },
  fxSpatial:      { key: 'spatial',         nested: true,  nestedKey: 'enabled' },
  fxVocalRemover: { key: 'vocalRemover'     },
  fxMonoStereo:   { key: 'monoToStereo'     },
};

// ─── Initialization ───────────────────────────────────────────────────────────

(async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab  = tabs[0];

    if (!activeTab?.id) { showError('No active tab found.'); return; }

    // Show site hostname
    if (activeTab.url) {
      try { siteLabel.textContent = new URL(activeTab.url).hostname; } catch (_) {}
    }

    // Load current settings from content script
    await loadSettings();

    // Build EQ sliders from settings
    buildEQBands();

    // Apply settings to all UI controls
    renderUI();

    // Start visualizer stream
    startVisualizerStream();

  } catch (err) {
    console.error('[AudioHD Pro Popup] Init error:', err);
    showError('Could not connect to page audio. Navigate to a page with audio and reopen.');
  }
})();

// ─── Settings Loader ──────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const resp = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_STATUS' });
    if (resp?.settings) {
      settings = resp.settings;
      return;
    }
  } catch (_) {}

  // Fallback: load from storage
  const stored = await chrome.storage.sync.get('globalSettings').catch(() => ({}));
  settings = stored.globalSettings || getDefaultSettings();
}

function getDefaultSettings() {
  return {
    enabled: true, volume: 1.0,
    eqBands: [0,0,0,0,0,0,0,0,0,0],
    compressor: { enabled: true, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
    spatial: { enabled: false }, reverb: { enabled: false, wetness: 0.3 },
    subBassEnhancer: false, hdCrystalizer: false, monoToStereo: false, vocalRemover: false,
    preset: 'flat',
  };
}

// ─── UI Rendering ─────────────────────────────────────────────────────────────

function renderUI() {
  if (!settings) return;

  // Power toggle
  enableToggle.checked = settings.enabled ?? true;

  // Volume slider (0–600 %)
  const pct = Math.round((settings.volume ?? 1) * 100);
  volumeSlider.value = Math.min(600, pct);
  updateVolumeDisplay(pct);

  // EQ bands
  updateEQDisplay();

  // Preset pills
  document.querySelectorAll('.pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.preset === settings.preset);
  });

  // FX toggles
  for (const [id, meta] of Object.entries(FX_MAP)) {
    const el = $(id);
    if (!el) continue;
    if (meta.nested) {
      el.checked = settings[meta.key]?.[meta.nestedKey] ?? false;
    } else {
      el.checked = settings[meta.key] ?? false;
    }
  }
}

function updateVolumeDisplay(pct) {
  volumeValue.textContent = `${pct}%`;
  // Update CSS gradient fill
  const fraction = pct / 600;
  volumeSlider.style.setProperty('--pct', `${(fraction * 100).toFixed(1)}%`);
}

// ─── EQ Builder ───────────────────────────────────────────────────────────────

function buildEQBands() {
  eqBandsEl.innerHTML = '';
  EQ_LABELS.forEach((label, i) => {
    const gain = settings?.eqBands?.[i] ?? 0;

    const band     = document.createElement('div');
    band.className = 'eq-band';
    band.innerHTML = `
      <div class="eq-band-value${gain !== 0 ? ' active' : ''}" id="eqVal${i}">
        ${gain > 0 ? '+' : ''}${gain}
      </div>
      <input type="range" id="eq${i}"
             min="-15" max="15" step="0.5" value="${gain}"
             aria-label="${label} EQ band">
      <div class="eq-band-label">${label}</div>
    `;
    eqBandsEl.appendChild(band);

    const slider = band.querySelector('input');
    slider.addEventListener('input', () => onEQChange(i, parseFloat(slider.value)));
  });
}

function updateEQDisplay() {
  EQ_LABELS.forEach((_, i) => {
    const gain      = settings?.eqBands?.[i] ?? 0;
    const slider    = $(`eq${i}`);
    const valEl     = $(`eqVal${i}`);
    if (slider) slider.value = gain;
    if (valEl)  {
      valEl.textContent = `${gain > 0 ? '+' : ''}${gain}`;
      valEl.classList.toggle('active', gain !== 0);
    }
  });
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

/** Power toggle */
enableToggle.addEventListener('change', () => {
  settings.enabled = enableToggle.checked;
  sendToTab({ type: 'TOGGLE_FEATURE', feature: 'enabled', value: settings.enabled });
  saveSettings();
});

/** Volume slider */
volumeSlider.addEventListener('input', () => {
  const pct    = parseInt(volumeSlider.value, 10);
  const vol    = pct / 100;
  settings.volume = vol;
  updateVolumeDisplay(pct);
  sendToTab({ type: 'SET_VOLUME', volume: vol });
});
volumeSlider.addEventListener('change', saveSettings);

/** EQ band change */
function onEQChange(band, gain) {
  if (!settings.eqBands) settings.eqBands = [0,0,0,0,0,0,0,0,0,0];
  settings.eqBands[band] = gain;
  const valEl = $(`eqVal${band}`);
  if (valEl) {
    valEl.textContent = `${gain > 0 ? '+' : ''}${gain}`;
    valEl.classList.toggle('active', gain !== 0);
  }
  sendToTab({ type: 'SET_EQ', band, gain });
  debouncedSave();
}

/** EQ Reset */
eqResetBtn.addEventListener('click', () => {
  settings.eqBands = new Array(10).fill(0);
  settings.preset  = 'flat';
  updateEQDisplay();
  document.querySelectorAll('.pill').forEach(p =>
    p.classList.toggle('active', p.dataset.preset === 'flat')
  );
  sendToTab({ type: 'SET_PRESET', preset: 'flat' });
  saveSettings();
});

/** Preset pills */
presetPills.addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  const preset = pill.dataset.preset;

  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');

  settings.preset = preset;
  // EQ will be updated on the content-script side
  sendToTab({ type: 'SET_PRESET', preset });

  // Animate sliders to new values by fetching from background (approximate)
  const presetGains = {
    flat:[0,0,0,0,0,0,0,0,0,0], bass:[8,7,5,2,0,-1,-1,0,1,2],
    vocal:[-2,-2,0,4,6,6,4,2,0,-2], cinematic:[5,4,2,0,-1,0,2,4,5,6],
    night:[3,2,1,0,-2,-2,-1,0,1,2], rock:[4,3,2,0,-1,0,2,4,4,3],
    pop:[1,2,3,2,0,-1,2,3,3,2],
  };
  if (presetGains[preset]) {
    settings.eqBands = [...presetGains[preset]];
    updateEQDisplay();
  }
  saveSettings();
});

/** FX toggles */
for (const [id, meta] of Object.entries(FX_MAP)) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener('change', () => {
    if (meta.nested) {
      if (!settings[meta.key]) settings[meta.key] = {};
      settings[meta.key][meta.nestedKey] = el.checked;
      sendToTab({ type: 'TOGGLE_FEATURE', feature: meta.key, value: settings[meta.key] });
    } else {
      settings[meta.key] = el.checked;
      sendToTab({ type: 'TOGGLE_FEATURE', feature: meta.key, value: el.checked });
    }
    saveSettings();
  });
}

/** Save site profile */
saveSiteBtn.addEventListener('click', async () => {
  const hostname = siteLabel.textContent.trim();
  if (!hostname || hostname === '—') return;
  await chrome.runtime.sendMessage({ type: 'SAVE_SITE_PROFILE', hostname, settings });
  animateButton(saveSiteBtn, '✓ Saved!');
});

// ─── Messaging ────────────────────────────────────────────────────────────────

function sendToTab(msg) {
  if (!activeTab?.id) return;
  chrome.tabs.sendMessage(activeTab.id, msg).catch(() => {});
}

async function saveSettings() {
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }).catch(() => {});
}

let saveTimer = null;
function debouncedSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 600);
}

// ─── Visualizer ───────────────────────────────────────────────────────────────

function startVisualizerStream() {
  if (!activeTab?.id) return;

  try {
    visPort = chrome.tabs.connect(activeTab.id, { name: 'visualizer' });
    visPort.postMessage({ type: 'START_STREAM' });
    visPort.onMessage.addListener((msg) => {
      if (msg.type === 'FREQ_DATA') {
        if (msg.freq?.length)     freqData = new Uint8Array(msg.freq);
        if (msg.waveform?.length) waveData = new Uint8Array(msg.waveform);
      }
    });
    visPort.onDisconnect.addListener(() => { visPort = null; });
  } catch (_) {
    // Port connection failed — use polling fallback (no visualizer data)
  }

  drawVisualizer();
}

function drawVisualizer() {
  visRAF = requestAnimationFrame(drawVisualizer);

  const W = canvas.width;
  const H = canvas.height;
  ctx2d.clearRect(0, 0, W, H);

  // Background
  ctx2d.fillStyle = 'rgba(0,0,0,0.0)';
  ctx2d.fillRect(0, 0, W, H);

  const barCount = 80;
  const binStep  = Math.floor(freqData.length / barCount);
  const barW     = W / barCount;
  const maxH     = H - 4;

  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    for (let j = 0; j < binStep; j++) sum += freqData[i * binStep + j] ?? 0;
    const avg = sum / binStep;
    const barH = (avg / 255) * maxH;

    // Color gradient: teal at top → blue at bottom
    const hue  = 165 + (i / barCount) * 40;
    const sat  = 80;
    const lum  = 55;
    const alpha = 0.75 + (avg / 255) * 0.25;

    // Gradient per bar
    const grad = ctx2d.createLinearGradient(0, H - barH, 0, H);
    grad.addColorStop(0,   `hsla(${hue}, ${sat}%, ${lum + 15}%, ${alpha})`);
    grad.addColorStop(0.7, `hsla(${hue}, ${sat}%, ${lum}%, ${alpha * 0.6})`);
    grad.addColorStop(1,   `hsla(${hue}, ${sat}%, ${lum}%, 0)`);

    ctx2d.fillStyle = grad;

    const x = i * barW + 0.5;
    const w = Math.max(1, barW - 1.5);

    // Main bar
    ctx2d.fillRect(x, H - barH, w, barH);

    // Peak cap
    if (barH > 4) {
      ctx2d.fillStyle = `hsla(${hue}, 90%, 75%, 0.9)`;
      ctx2d.fillRect(x, H - barH, w, 2);
    }
  }

  // Waveform overlay (thin oscilloscope line)
  if (waveData.length > 0) {
    ctx2d.beginPath();
    ctx2d.strokeStyle = 'rgba(0, 230, 180, 0.25)';
    ctx2d.lineWidth   = 1;
    const step = W / waveData.length;
    for (let i = 0; i < waveData.length; i++) {
      const y = ((waveData[i] - 128) / 128) * (H * 0.4) + H * 0.5;
      if (i === 0) ctx2d.moveTo(0, y);
      else ctx2d.lineTo(i * step, y);
    }
    ctx2d.stroke();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function animateButton(btn, text) {
  const orig = btn.innerHTML;
  btn.innerHTML = text;
  btn.style.color = 'var(--accent)';
  setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 1800);
}

function showError(msg) {
  document.querySelector('.popup-root').innerHTML = `
    <div style="padding:24px 20px; color: var(--text-secondary); font-size:12px; line-height:1.6;">
      <div style="font-size:20px; margin-bottom:8px;">⚠️</div>
      ${msg}
    </div>
  `;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

window.addEventListener('unload', () => {
  if (visPort) { visPort.postMessage({ type: 'STOP_STREAM' }); visPort.disconnect(); }
  if (visRAF)  cancelAnimationFrame(visRAF);
});
