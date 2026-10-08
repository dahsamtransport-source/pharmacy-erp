import "server-only";
import { createClient } from "@supabase/supabase-js";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { isLoopbackDataApi } from "@/lib/pharmacy/connectivity";
import type { Database } from "@/lib/pharmacy/contracts";
import { AssistantFailure, type AssistantContext } from "./request-handler";
export async function authorizeAssistant(
  token: string,
  org: string,
  warehouse: string,
  signal: AbortSignal,
): Promise<AssistantContext> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key?.startsWith("sb_publishable_"))
    throw new AssistantFailure("ASSISTANT_UNAVAILABLE", 503);
  const endpoint = new URL(url);
  if (
    endpoint.username ||
    endpoint.password ||
    (endpoint.protocol !== "https:" && !isLoopbackDataApi(url))
  )
    throw new AssistantFailure("ASSISTANT_UNAVAILABLE", 503);
  // Request-local user token, never a service-role client.
  const client = createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        }),
    },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous)
    throw new AssistantFailure("UNAUTHORIZED", 401);
  const api = pharmacyApi(client);
  const workspace = (await api.context()).find(
    (w) => w.id === org && w.warehouses.some((w) => w.id === warehouse),
  );
  if (!workspace) throw new AssistantFailure("FORBIDDEN", 403);
  return { actor: data.user.id, workspace, api };
}
