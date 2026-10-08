import { afterEach, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import PharmacyApp from "@/features/pharmacy/PharmacyApp";
import { useAppearance } from "@/features/pharmacy/appearance";

afterEach(() => localStorage.removeItem("ympharma-appearance"));
function AppearanceProbe() {
  const { mode, toggle } = useAppearance();
  return <button onClick={toggle}>{mode}</button>;
}
it("persists appearance across a fresh mount without requiring account access", () => {
  const first = render(<AppearanceProbe />);
  fireEvent.click(screen.getByRole("button", { name: "light" }));
  expect(localStorage.getItem("ympharma-appearance")).toBe("dark");
  first.unmount();
  render(<AppearanceProbe />);
  expect(screen.getByRole("button", { name: "dark" })).toBeTruthy();
});
it("keeps the accounting shell keyboard accessible while disconnected", () => {
  render(<PharmacyApp />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "البحث العام عن صنف أو تشغيلة" }),
  );
  const menu = screen.getByRole("button", { name: "فتح القائمة" });
  fireEvent.click(menu);
  expect(screen.getByRole("dialog", { name: "القائمة الجانبية" })).toBeTruthy();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "القائمة الجانبية" })).toBeNull();
  expect(document.activeElement).toBe(menu);
  expect(document.body.style.overflow).not.toBe("hidden");
});
