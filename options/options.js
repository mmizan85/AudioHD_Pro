/**
 * AudioHD Pro — Options Page Script
 * ============================================================
 * Manages the full-page settings UI:
 *  - Navigation between sections
 *  - Loading and saving all settings categories
 *  - Site profile management (view, delete)
 *  - Keyboard shortcut recording
 *  - Import / Export settings as JSON
 *  - Reset to defaults
 *
 * @module OptionsScript
 */

'use strict';

// ─── Navigation ───────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const target = item.dataset.section;

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(`section-${target}`)?.classList.add('active');
  });
});

// ─── Utility ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function showToast(msg, duration = 2200) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

/**
 * Wires up a range input to display its value in a badge element.
 * @param {string} sliderId
 * @param {string} badgeId
 * @param {function} formatter - (value) => displayString
 */
function bindSlider(sliderId, badgeId, formatter) {
  const slider = $(sliderId);
  const badge  = $(badgeId);
  if (!slider || !badge) return;

  const update = () => {
    const frac = (parseFloat(slider.value) - parseFloat(slider.min)) /
                 (parseFloat(slider.max)  - parseFloat(slider.min));
    badge.textContent = formatter(parseFloat(slider.value));
    slider.style.setProperty('--pct', `${(frac * 100).toFixed(1)}%`);
  };

  slider.addEventListener('input', update);
  update(); // Initial render
}

// ─── Settings Load/Save ───────────────────────────────────────────────────────

/** Loads all settings from sync storage and populates form controls. */
async function loadAllSettings() {
  const stored = await chrome.storage.sync.get(['globalSettings', 'shortcuts']);
  const s  = stored.globalSettings  || {};
  const sc = stored.shortcuts        || {};

  // General
  if ($('opt-volume')) {
    $('opt-volume').value = Math.round((s.volume ?? 1) * 100);
    $('opt-volume').dispatchEvent(new Event('input'));
  }
  if ($('opt-preset'))              $('opt-preset').value = s.preset ?? 'flat';
  if ($('opt-compressor-enabled'))  $('opt-compressor-enabled').checked = s.compressor?.enabled ?? true;
  if ($('opt-subBass'))             $('opt-subBass').checked = s.subBassEnhancer ?? false;
  if ($('opt-crystal'))             $('opt-crystal').checked = s.hdCrystalizer ?? false;
  if ($('opt-debug'))               $('opt-debug').checked   = s.debugMode ?? false;

  // Compressor
  if ($('comp-threshold')) { $('comp-threshold').value = s.compressor?.threshold ?? -24; $('comp-threshold').dispatchEvent(new Event('input')); }
  if ($('comp-knee'))      { $('comp-knee').value      = s.compressor?.knee      ?? 30;  $('comp-knee').dispatchEvent(new Event('input')); }
  if ($('comp-ratio'))     { $('comp-ratio').value     = s.compressor?.ratio     ?? 12;  $('comp-ratio').dispatchEvent(new Event('input')); }
  if ($('comp-attack'))    { $('comp-attack').value    = s.compressor?.attack    ?? 0.003; $('comp-attack').dispatchEvent(new Event('input')); }
  if ($('comp-release'))   { $('comp-release').value   = s.compressor?.release   ?? 0.25; $('comp-release').dispatchEvent(new Event('input')); }

  // Reverb & Spatial
  if ($('reverb-room')) $('reverb-room').value = s.reverb?.roomSize ?? 'medium';
  if ($('reverb-wet'))  { $('reverb-wet').value = s.reverb?.wetness ?? 0.3; $('reverb-wet').dispatchEvent(new Event('input')); }
  if ($('spatial-x'))   { $('spatial-x').value  = s.spatial?.panX ?? 0; $('spatial-x').dispatchEvent(new Event('input')); }
  if ($('spatial-y'))   { $('spatial-y').value  = s.spatial?.panY ?? 0; $('spatial-y').dispatchEvent(new Event('input')); }
  if ($('spatial-z'))   { $('spatial-z').value  = s.spatial?.panZ ?? 1; $('spatial-z').dispatchEvent(new Event('input')); }

  // Shortcuts
  if ($('sc-volumeUp'))    $('sc-volumeUp').value    = sc.volumeUp    ?? 'ArrowUp';
  if ($('sc-volumeDown'))  $('sc-volumeDown').value  = sc.volumeDown  ?? 'ArrowDown';
  if ($('sc-toggleEQ'))    $('sc-toggleEQ').value    = sc.toggleEQ    ?? 'KeyE';
  if ($('sc-nextPreset'))  $('sc-nextPreset').value  = sc.nextPreset  ?? 'KeyP';
}

/** Collects current form state into a settings object. */
function collectSettings() {
  return {
    volume:          parseInt($('opt-volume')?.value ?? 100) / 100,
    preset:          $('opt-preset')?.value ?? 'flat',
    subBassEnhancer: $('opt-subBass')?.checked ?? false,
    hdCrystalizer:   $('opt-crystal')?.checked ?? false,
    debugMode:       $('opt-debug')?.checked  ?? false,
    compressor: {
      enabled:   $('opt-compressor-enabled')?.checked ?? true,
      threshold: parseFloat($('comp-threshold')?.value ?? -24),
      knee:      parseFloat($('comp-knee')?.value      ?? 30),
      ratio:     parseFloat($('comp-ratio')?.value     ?? 12),
      attack:    parseFloat($('comp-attack')?.value    ?? 0.003),
      release:   parseFloat($('comp-release')?.value   ?? 0.25),
    },
    reverb: {
      enabled:  false,
      roomSize: $('reverb-room')?.value ?? 'medium',
      wetness:  parseFloat($('reverb-wet')?.value ?? 0.3),
    },
    spatial: {
      enabled: false,
      panX: parseFloat($('spatial-x')?.value ?? 0),
      panY: parseFloat($('spatial-y')?.value ?? 0),
      panZ: parseFloat($('spatial-z')?.value ?? 1),
    },
  };
}

// ─── Slider Bindings ──────────────────────────────────────────────────────────

bindSlider('opt-volume',      'opt-volume-val',    v => `${Math.round(v)}%`);
bindSlider('comp-threshold',  'comp-threshold-val',v => `${v} dB`);
bindSlider('comp-knee',       'comp-knee-val',     v => `${v} dB`);
bindSlider('comp-ratio',      'comp-ratio-val',    v => `${v}:1`);
bindSlider('comp-attack',     'comp-attack-val',   v => `${Math.round(v * 1000)}ms`);
bindSlider('comp-release',    'comp-release-val',  v => `${Math.round(v * 1000)}ms`);
bindSlider('reverb-wet',      'reverb-wet-val',    v => `${Math.round(v * 100)}%`);
bindSlider('spatial-x',       'spatial-x-val',     v => v.toFixed(1));
bindSlider('spatial-y',       'spatial-y-val',     v => v.toFixed(1));
bindSlider('spatial-z',       'spatial-z-val',     v => v.toFixed(1));

// ─── Save Handlers ────────────────────────────────────────────────────────────

async function saveToStorage(partial) {
  const { globalSettings = {} } = await chrome.storage.sync.get('globalSettings');
  const merged = { ...globalSettings, ...partial };
  await chrome.storage.sync.set({ globalSettings: merged });
  // Notify all content scripts
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'APPLY_SETTINGS', settings: merged }).catch(() => {});
    });
  });
}

$('saveGeneralBtn')?.addEventListener('click', async () => {
  const s = collectSettings();
  await saveToStorage({
    volume: s.volume, preset: s.preset,
    subBassEnhancer: s.subBassEnhancer, hdCrystalizer: s.hdCrystalizer,
    debugMode: s.debugMode,
    compressor: { ...s.compressor, enabled: $('opt-compressor-enabled')?.checked ?? true },
  });
  showToast('✓ General settings saved');
});

$('saveCompBtn')?.addEventListener('click', async () => {
  const s = collectSettings();
  await saveToStorage({ compressor: s.compressor });
  showToast('✓ Compressor settings saved');
});

$('saveReverbBtn')?.addEventListener('click', async () => {
  const s = collectSettings();
  await saveToStorage({ reverb: s.reverb, spatial: s.spatial });
  showToast('✓ Reverb & Spatial settings saved');
});

$('saveShortcutsBtn')?.addEventListener('click', async () => {
  const shortcuts = {
    volumeUp:   $('sc-volumeUp')?.value   || 'ArrowUp',
    volumeDown: $('sc-volumeDown')?.value || 'ArrowDown',
    toggleEQ:   $('sc-toggleEQ')?.value   || 'KeyE',
    nextPreset: $('sc-nextPreset')?.value || 'KeyP',
  };
  await chrome.storage.sync.set({ shortcuts });
  showToast('✓ Shortcuts saved');
});

// ─── Keyboard Shortcut Recording ─────────────────────────────────────────────

document.querySelectorAll('.shortcut-input').forEach(input => {
  input.addEventListener('focus', () => {
    input.value = '— press a key —';
    input.style.color = 'var(--accent-blue)';
  });

  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      input.blur();
      return;
    }
    input.value = e.code;
    input.style.color = 'var(--accent)';
    input.blur();
  });

  input.addEventListener('blur', () => {
    if (input.value === '— press a key —') {
      // Restore previous value (load from storage)
      loadAllSettings();
    }
  });
});

// ─── Site Profiles ────────────────────────────────────────────────────────────

async function loadProfiles() {
  const { siteProfiles = {} } = await chrome.storage.sync.get('siteProfiles');
  const list = $('profilesList');
  if (!list) return;

  const domains = Object.keys(siteProfiles);
  if (domains.length === 0) {
    list.innerHTML = `<div class="empty-state">No site profiles saved yet.<br>
      Use the popup's "Save Site Profile" button while on any site.</div>`;
    return;
  }

  list.innerHTML = '';
  domains.forEach(domain => {
    const profile = siteProfiles[domain];
    const item    = document.createElement('div');
    item.className = 'profile-item';
    item.innerHTML = `
      <div>
        <div class="profile-domain">${domain}</div>
        <div class="profile-meta">Volume: ${Math.round((profile.volume ?? 1) * 100)}% · Preset: ${profile.preset ?? 'flat'}</div>
      </div>
      <div class="profile-actions">
        <button class="btn-icon" data-domain="${domain}" title="Delete profile">✕</button>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.btn-icon').forEach(btn => {
    btn.addEventListener('click', async () => {
      const d = btn.dataset.domain;
      if (!confirm(`Delete profile for "${d}"?`)) return;
      await chrome.runtime.sendMessage({ type: 'DELETE_SITE_PROFILE', hostname: d });
      showToast(`✓ Profile for "${d}" deleted`);
      loadProfiles();
    });
  });
}

// ─── Reset ────────────────────────────────────────────────────────────────────

$('resetAllBtn')?.addEventListener('click', async () => {
  if (!confirm('Reset ALL settings and site profiles? This cannot be undone.')) return;

  const defaults = {
    enabled: true, volume: 1.0,
    eqBands: [0,0,0,0,0,0,0,0,0,0],
    compressor: { enabled: true, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
    spatial:    { enabled: false, panX: 0, panY: 0, panZ: 1 },
    reverb:     { enabled: false, wetness: 0.3, roomSize: 'medium' },
    subBassEnhancer: false, hdCrystalizer: false,
    monoToStereo: false, vocalRemover: false,
    preset: 'flat', debugMode: false,
  };
  await chrome.storage.sync.set({ globalSettings: defaults, siteProfiles: {}, shortcuts: {} });
  showToast('✓ All settings reset to defaults');
  loadAllSettings();
  loadProfiles();
});

// ─── Export / Import ──────────────────────────────────────────────────────────

$('exportBtn')?.addEventListener('click', async () => {
  const data = await chrome.storage.sync.get(null);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'audiohd-pro-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('✓ Settings exported');
});

$('importBtn')?.addEventListener('click', () => $('importFile')?.click());

$('importFile')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.globalSettings) {
      showToast('⚠ Invalid file format', 2500);
      return;
    }

    await chrome.storage.sync.set(data);
    showToast('✓ Settings imported successfully');
    loadAllSettings();
    loadProfiles();
  } catch (err) {
    showToast('⚠ Import failed: ' + err.message, 3000);
  }

  e.target.value = '';
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadAllSettings();
  await loadProfiles();
})();
