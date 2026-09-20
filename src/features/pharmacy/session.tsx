"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { browserClient, pharmacyApi, ApiFailure } from "@/lib/pharmacy/api";
import type { PharmacyApi, Workspace } from "@/lib/pharmacy/contracts";
type AuthState =
  | {
      status: "unconfigured" | "loading" | "anonymous" | "error";
      message?: string;
    }
  | { status: "ready"; userId: string; name: string; workspaces: Workspace[] };
interface SessionValue {
  auth: AuthState;
  api: PharmacyApi | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  refresh(): void;
}
const Context = createContext<SessionValue | null>(null);
export function PharmacySession({ children }: { children: ReactNode }) {
  const [client] = useState(browserClient);
  const api = useMemo(() => (client ? pharmacyApi(client) : null), [client]);
  const [auth, setAuth] = useState<AuthState>({
    status: client ? "loading" : "unconfigured",
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!client || !api) return;
    let active = true;
    let sequence = 0;
    const unsubscribe = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      const run = ++sequence;
      if (!session) {
        setAuth({ status: "anonymous" });
        return;
      }
      setAuth((previous) =>
        previous.status === "ready" && previous.userId === session.user.id
          ? previous
          : { status: "loading" },
      );
      // Keep the auth callback synchronous to avoid Supabase's auth lock deadlock.
      queueMicrotask(() => {
        void client.auth
          .getUser()
          .then(async ({ data, error }) => {
            if (error || !data.user) {
              if (active && run === sequence) setAuth({ status: "anonymous" });
              return;
            }
            const workspaces = await api.context();
            const display = data.user.user_metadata?.full_name;
            if (active && run === sequence)
              setAuth({
                status: "ready",
                userId: data.user.id,
                name: typeof display === "string" ? display : "",
                workspaces,
              });
          })
          .catch(() => {
            if (active && run === sequence)
              setAuth({
                status: "error",
                message:
                  "تعذّر تحميل مساحة العمل. تحقّق من إعداد الحساب وخدمة البيانات.",
              });
          });
      });
    }).data.subscription;
    return () => {
      active = false;
      unsubscribe.unsubscribe();
    };
  }, [client, api, revision]);
  const value: SessionValue = {
    auth,
    api,
    refresh: () => setRevision((n) => n + 1),
    signIn: async (email, password) => {
      if (!client) throw new ApiFailure("خدمة تسجيل الدخول غير مهيأة.");
      const { error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error)
        throw new ApiFailure(
          "تعذّر تسجيل الدخول. راجع البريد وكلمة المرور أو حاول لاحقًا.",
        );
    },
    signOut: async () => {
      if (client) {
        const { error } = await client.auth.signOut({ scope: "local" });
        if (error) throw new ApiFailure("تعذّر إنهاء الجلسة. حاول مجددًا.");
      }
      setAuth({ status: "anonymous" });
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePharmacySession() {
  const c = useContext(Context);
  if (!c) throw new Error("Missing pharmacy session");
  return c;
}
