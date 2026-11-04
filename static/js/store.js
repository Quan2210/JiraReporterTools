import { debounce } from "./api.js";
import { defaultProfile, sanitizeProfile } from "./lib/profile.js";

const KEY = "jira-report-profile";
const listeners = new Set();

export const store = { profile: defaultProfile(), persistFailed: false };

export function loadProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) store.profile = sanitizeProfile(JSON.parse(raw));
  } catch {
    store.profile = defaultProfile();   // blocked storage or a corrupt entry: start clean, never crash
  }
  return store.profile;
}

const persist = debounce(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(store.profile));
    store.persistFailed = false;
  } catch {
    store.persistFailed = true;
  }
  listeners.forEach((fn) => fn());
}, 400);

/** Call after mutating store.profile. */
export const saveProfile = persist;
export const onPersist = (fn) => listeners.add(fn);

export function replaceProfile(profile) {
  store.profile = profile;
  persist();
}
