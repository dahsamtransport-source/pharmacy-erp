// Integer arithmetic for display estimates. The database owns the final totals.
// Hosted YmPharma uses numeric(...,4). Never truncate those values to cents.
export function accountingUnits(value: string): bigint {
  if (!/^-?\d+(\.\d{1,4})?$/.test(value)) throw new Error("INVALID_MONEY");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  return (
    (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"))) *
    (negative ? -1n : 1n)
  );
}
export function accountingDecimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const n = value < 0n ? -value : value;
  const fraction = (n % 10000n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${sign}${n / 10000n}.${fraction}`;
}
export function minorUnits(value: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error("INVALID_MONEY");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  return (
    (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))) *
    (negative ? -1n : 1n)
  );
}
export function decimalUnits(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const n = value < 0n ? -value : value;
  return `${sign}${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
}
export function formatAmount(value: string | null | undefined): string {
  if (value == null) return "—";
  accountingUnits(value);
  const [whole, fraction = "00"] = value.split(".");
  const sign = value.startsWith("-") && BigInt(whole) === 0n ? "-" : "";
  return `${sign}${BigInt(whole).toLocaleString("ar-YE-u-nu-latn")}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}
export function purchaseLineTotal(cost: string, quantity: number): bigint {
  if (
    !/^\d{1,8}(\.\d{1,4})?$/.test(cost) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  )
    throw new Error("INVALID_MONEY");
  const [whole, fraction = ""] = cost.split(".");
  const tenThousand = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
  return tenThousand * BigInt(quantity);
}
export function percentChange(
  today: string | null,
  yesterday: string | null,
): string | null {
  if (today === null || yesterday === null) return null;
  const prev = accountingUnits(yesterday);
  if (prev === 0n) return null;
  const rounded = ((accountingUnits(today) - prev) * 100n) / prev;
  return `${rounded > 0n ? "+" : ""}${rounded}%`;
}
