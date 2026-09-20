"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { canAttemptDataRequest } from "@/lib/pharmacy/connectivity";
export function useRemote<T>(load: () => Promise<T> | null, identity: string) {
  const [revision, setRevision] = useState(0);
  const key = `${identity}:${revision}`;
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: unknown;
  }>();
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(load)
      .then((data) => {
        if (active) setResult(data === null ? { key } : { key, data });
      })
      .catch((error: unknown) => {
        if (active) setResult({ key, error });
      });
    return () => {
      active = false;
    };
  }, [load, key]);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  return {
    data: result?.key === key ? result.data : undefined,
    error: result?.key === key ? result.error : undefined,
    loading: result?.key !== key,
    reload,
  };
}
const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
export const useOnline = () =>
  useSyncExternalStore(subscribe, canAttemptDataRequest, () => true);
