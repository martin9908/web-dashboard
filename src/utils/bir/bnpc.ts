// Basic necessities and prime commodities (BNPC): SC/PWD/MOV on such a line is
// 5% of the regular retail price, VAT not exempted (DA-DTI-DOE JAO, March
// 2024). Mirror of the device's HelperFunctions/retailPricing.bnpcLineRate
// (utakretailBIR b3996b17); every aggregation books these lines through this
// one test, like a regular discount, under the buyer's SC/PWD/MOV category.

export const BNPC_RATE = 0.05;
export const BNPC_BUYER_TYPES: readonly string[] = ['senior', 'pwd', 'medalOfValor'];

/**
 * The discount rate of a BNPC SC/PWD/MOV line, or null for any other line.
 * `bnpcRate` on the line is the weekly-cap rate the retail app set (never
 * above 5%). Per-head (pax) lines keep their own path and return null.
 * `discType` is the item-level type, already normalised by the caller.
 */
export const bnpcLineRate = (item: any, discType: string | undefined = item?.individualDiscountType): number | null => {
  if (!item || item.isCommodity !== true || item.paxDiscount) return null;
  if (!BNPC_BUYER_TYPES.includes(String(discType))) return null;
  const capped = Number(item.bnpcRate);
  return item.bnpcRate != null && Number.isFinite(capped) ? Math.max(0, Math.min(capped, BNPC_RATE)) : BNPC_RATE;
};
