"use client";
import { useSyncExternalStore } from "react";

const key = "ympharma-appearance";
const eventName = "ympharma-appearance-change";
let fallback = "light";
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
}
function snapshot() {
  try {
    return localStorage.getItem(key) === "dark" ? "dark" : "light";
  } catch {
    return fallback;
  }
}
export function useAppearance() {
  const mode = useSyncExternalStore(subscribe, snapshot, () => "light");
  function toggle() {
    fallback = mode === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(key, fallback);
    } catch {
      /* Private storage may be unavailable. */
    }
    window.dispatchEvent(new Event(eventName));
  }
  return { mode, toggle };
}
