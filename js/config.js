/**
 * PodSync web config. Mirrors config.py's DEFAULT_CONFIG shape and
 * persists to localStorage under the key `podsync.config.v1`.
 *
 * Scope is per-origin per-browser - a user who clears site data OR
 * logs in on a different machine will need to enter their password
 * again. That's the expected behavior for a browser app.
 */

const STORAGE_KEY = 'podsync.config.v1';

const DEFAULTS = {
  username: '',
  display_name: '',
  email: '',
  library_password: '',
  is_setup: false,
  admin_token: '',

  // Device IDs are browser-local (different hash on every origin) so
  // we just remember labels as a soft hint.
  input_device: '',
  output_device: '',
  input_device_label: '',
  output_device_label: '',

  sample_rate: 48000,
  channels: 1,
  bit_depth: 16,

  relay_url: '',   // blank = default (Hetzner)
  library_base: '',

  last_session_id: '',
  last_session_room: '',
  last_session_pin: '',
  last_session_host: '',
};


export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

export function clearConfig() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
