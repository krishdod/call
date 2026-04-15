const STORAGE_KEY = "vv_signaling_url";
const LOCAL_DEFAULT = "http://localhost:4000";

function cleanUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) return "";
  if (!/^https?:\/\//i.test(normalized)) return "";
  return normalized;
}

export function getSignalingUrl() {
  const fromEnv = cleanUrl(import.meta.env.VITE_SIGNALING_URL);
  if (fromEnv) return fromEnv;

  if (typeof window === "undefined") return LOCAL_DEFAULT;

  const fromStorage = cleanUrl(window.localStorage?.getItem(STORAGE_KEY));
  if (fromStorage) return fromStorage;

  const isLocalHost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (isLocalHost) return LOCAL_DEFAULT;

  return "";
}

export function saveSignalingUrl(value) {
  if (typeof window === "undefined") return "";
  const cleaned = cleanUrl(value);
  if (!cleaned) return "";
  window.localStorage?.setItem(STORAGE_KEY, cleaned);
  return cleaned;
}

export function hasStaticSignalingUrl() {
  return Boolean(cleanUrl(import.meta.env.VITE_SIGNALING_URL));
}
