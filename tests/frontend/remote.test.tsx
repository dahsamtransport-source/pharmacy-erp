import { it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRemote } from "@/hooks/use-remote";

it("drops old account data and ignores a late response after identity changes", async () => {
  let resolveOld: (value: string) => void = () => {};
  const oldLoad = () =>
    new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
  const newLoad = () => Promise.resolve("current account");
  const { result, rerender } = renderHook(
    ({ load, identity }) => useRemote(load, identity),
    { initialProps: { load: oldLoad, identity: "old-user" } },
  );
  await act(async () => {});
  rerender({ load: newLoad, identity: "new-user" });
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(result.current.data).toBe("current account"));
  await act(async () => resolveOld("private old account data"));
  expect(result.current.data).toBe("current account");
});

it("finishes an unavailable request without an endless loading indicator", async () => {
  const load = () => null;
  const { result } = renderHook(() => useRemote(load, "unconfigured"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.data).toBeUndefined();
});
