import Moment from 'moment-timezone';
import { bnpcLineRate } from './bnpc';

import { roundMoney } from './money';

const VAT_RATE = 0.12;
const SENIOR_RATE = 0.2;
const PWD_RATE = 0.2;
const NAAC_RATE = 0.2;
const SOLO_PARENT_RATE = 0.1;
const MEDAL_OF_VALOR_RATE = 0.2;
const COMMODITY_RATE = 0.05;

const normalizeDiscountType = (type: string | null | undefined): string => {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return '';
  if (['sc', 'senior', 'seniorcitizen', 'senior_citizen'].includes(t)) return 'senior';
  if (['pwd', 'personwithdisability', 'person_with_disability'].includes(t)) return 'pwd';
  if (['sp', 'soloparent', 'solo_parent'].includes(t)) return 'soloParent';
  if (['ntl', 'ntlathlete', 'naac', 'nationalathlete'].includes(t)) return 'ntlAthlete';
  if (['diplomat'].includes(t)) return 'diplomat';
  if (['mov', 'medalofvalor', 'medal_of_valor'].includes(t)) return 'medalOfValor';
  if (['commodity'].includes(t)) return 'commodity';
  if (['regular'].includes(t)) return 'regular';
  // Promotional discounts behave exactly like regular percentage discounts.
  if (['promotional', 'promo'].includes(t)) return 'regular';
  return String(type || '');
};

/**
 * Narrower type mapper used only by the void PAX branch, mirroring the device.
 * Unlike normalizeDiscountType it does not fold promotional into regular and
 * returns '' for anything it does not recognise.
 */
const normalizeVoidPaxType = (t: string | null | undefined): string => {
  const normalized = String(t || '').trim().toLowerCase();
  if (['sc', 'senior'].includes(normalized)) return 'senior';
  if (['pwd'].includes(normalized)) return 'pwd';
  if (['sp', 'soloparent'].includes(normalized)) return 'soloParent';
  if (['ntl', 'naac'].includes(normalized)) return 'ntlAthlete';
  if (['diplomat'].includes(normalized)) return 'diplomat';
  if (['mov', 'medalofvalor'].includes(normalized)) return 'medalOfValor';
  if (['regular'].includes(normalized)) return 'regular';
  return '';
};

const resolveDiscountType = (item: any): string => {
  const explicit = normalizeDiscountType(item.individualDiscountType || item.transactionDiscountType || '');
  if (explicit) return explicit;

  const pax = item?.paxDiscount;
  if (!pax || typeof pax !== 'object') return '';

  if (pax.senior) return 'senior';
  if (pax.pwd) return 'pwd';
  if (pax.sp) return 'soloParent';
  if (pax.ntl) return 'ntlAthlete';
  if (pax.diplomat) return 'diplomat';
  if (pax.medalOfValor) return 'medalOfValor';
  if (pax.regular) return 'regular';
  return '';
};

const resolveDiscountRate = (item: any, discountType: string): number => {
  const pax = item?.paxDiscount;
  if (pax && typeof pax === 'object') {
    if (discountType === 'senior' && pax.senior) return (parseFloat(pax.senior.percent) || 20) / 100;
    if (discountType === 'pwd' && pax.pwd) return (parseFloat(pax.pwd.percent) || 20) / 100;
    if (discountType === 'soloParent' && pax.sp) return (parseFloat(pax.sp.percent) || 10) / 100;
    if (discountType === 'medalOfValor' && pax.medalOfValor)
      return (parseFloat(pax.medalOfValor.percent) || 20) / 100;
    if (discountType === 'regular' && pax.regular) return (parseFloat(pax.regular.percent) || 0) / 100;
  }

  if (discountType === 'senior') return SENIOR_RATE;
  if (discountType === 'pwd') return PWD_RATE;
  if (discountType === 'soloParent') return SOLO_PARENT_RATE;
  if (discountType === 'medalOfValor') return MEDAL_OF_VALOR_RATE;
  return 0;
};

interface RefundSummaryItem {
  refundKey: string;
  transactionKey: string;
  date: string;
  refundNo: number | null;
  receiptNo: string | number;
  receiptCycle: number;
  vatableSales: number;
  vatAmount: number;
  vatExemptSales: number;
  zeroRatedSales: number;
  refundGrandTotal: number;
  totalRefundAmount: number;
}

interface RefundSummaryResult extends Array<any> {
  beginningRefundSI?: string;
  endingRefundSI?: string;
  refundsByPaymentType?: { [key: string]: number };
}

export const getRefundSummary = (snapshot: any): RefundSummaryResult => {
  const data: RefundSummaryItem[] = [];
  const refundsByPaymentType: { [key: string]: number } = {};

  if (!snapshot || !snapshot.forEach) {
    const result: RefundSummaryResult = data as any;
    result.beginningRefundSI = '';
    result.endingRefundSI = '';
    result.refundsByPaymentType = refundsByPaymentType;
    return result;
  }

  snapshot.forEach((snap: any) => {
    const key = snap.key;
    const value = snap.val();

    if (value.trainingMode) return;

    const paymentType = value.paymentType || 'Cash';
    const refundTotal = Math.abs(parseFloat(value.total) || 0);
    if (refundTotal > 0) {
      refundsByPaymentType[paymentType] = (refundsByPaymentType[paymentType] || 0) + refundTotal;
    }

    const matchKey = value.originalRefundKey != null ? String(value.originalRefundKey) : String(key);
    const isRefundedItem = (item: any) => item != null && item.refund != null && String(item.refund) === matchKey;
    const refundedItems = (value.items || []).filter(isRefundedItem);

    let vatableSales = 0;
    let vatAmount = 0;
    let vatExemptSales = 0;
    let zeroRatedSales = 0;
    let refundGrandTotal = 0;
    let salesAdjVatAmount = 0;

    for (const item of refundedItems) {
      const vatType = item._defaultVatType ? item._defaultVatType : item.zeroVAT ? 'vatExempt' : 'vatable';
      const totalPrice = (item.price || 0) * Math.abs(item.quantity || 1);

      refundGrandTotal += totalPrice;

      // PAX discount
      if (item.paxDiscount && typeof item.paxDiscount === 'object') {
        const guestCount = Object.values(item.paxDiscount as any).reduce(
          (a: number, e: any) => a + (parseInt(e?.guestCount, 10) || 0),
          0
        );
        if (guestCount > 0) {
          const isCommodity = item.isCommodity === true;
          const baseAmount = totalPrice / (1 + VAT_RATE);

          for (const [paxDiscType, discObj] of Object.entries(item.paxDiscount as any)) {
            const seatCount = parseInt((discObj as any)?.guestCount, 10) || 0;
            if (seatCount <= 0) continue;
            const guestRatio = seatCount / guestCount;
            const proportionalBase = baseAmount * guestRatio;
            const proportionalGross = totalPrice * guestRatio;
            const normalizedType = normalizeDiscountType(paxDiscType);

            const discRate =
              (parseFloat((discObj as any)?.percent) || 0) / 100 ||
              (normalizedType === 'senior' ||
              normalizedType === 'pwd' ||
              normalizedType === 'medalOfValor'
                ? SENIOR_RATE
                : normalizedType === 'soloParent'
                  ? SOLO_PARENT_RATE
                  : normalizedType === 'ntlAthlete'
                    ? NAAC_RATE
                    : 0);

            if (normalizedType === 'ntlAthlete') {
              vatableSales += proportionalBase * (1 - NAAC_RATE);
              vatAmount += proportionalBase * VAT_RATE;
            } else if (
              ['senior', 'pwd', 'soloParent', 'medalOfValor', 'commodity'].includes(normalizedType)
            ) {
              if (
                isCommodity &&
                (normalizedType === 'senior' ||
                  normalizedType === 'pwd' ||
                  normalizedType === 'medalOfValor')
              ) {
                const commodityRate = COMMODITY_RATE;
                vatableSales += proportionalBase * (1 - commodityRate);
                const partVat = proportionalBase * (1 - commodityRate) * VAT_RATE;
                vatAmount += partVat;
                salesAdjVatAmount += partVat;
              } else {
                vatExemptSales += proportionalBase * (1 - discRate);
              }
            } else if (normalizedType === 'diplomat') {
              zeroRatedSales += proportionalBase;
            } else if (normalizedType === 'regular') {
              const discounted = proportionalGross * (1 - discRate);
              vatableSales += discounted / (1 + VAT_RATE);
              const itemVat = discounted - discounted / (1 + VAT_RATE);
              vatAmount += itemVat;
              salesAdjVatAmount += itemVat;
            }
          }
          continue;
        }
      }

      const discountType = resolveDiscountType(item);
      // SC/PWD/MOV on a basic necessity (bnpc.ts): refunded like a regular
      // discount (VATable on the discounted price), at the line's own rate.
      // Mirrors the device (utakretailBIR b3996b17).
      const bnpcRate = bnpcLineRate(item, discountType);
      if (bnpcRate != null && (vatType === 'vatable' || !vatType)) {
        const discountedPrice = totalPrice * (1 - bnpcRate);
        vatableSales += discountedPrice / (1 + VAT_RATE);
        const itemVat = discountedPrice - discountedPrice / (1 + VAT_RATE);
        vatAmount += itemVat;
        salesAdjVatAmount += itemVat;
      } else if (bnpcRate != null && vatType === 'vatExempt') {
        vatExemptSales += totalPrice;
      } else if (bnpcRate != null && vatType === 'zeroVat') {
        zeroRatedSales += totalPrice / 1.12;
      } else if (discountType === 'ntlAthlete') {
        const naacBase = totalPrice / (1 + VAT_RATE);
        const naacDiscountedBase = naacBase * (1 - NAAC_RATE);
        vatableSales += naacDiscountedBase;
        vatAmount += naacBase * VAT_RATE;
      } else if (
        ['senior', 'pwd', 'soloParent', 'medalOfValor', 'commodity'].includes(discountType)
      ) {
        const discountRate = resolveDiscountRate(item, discountType);
        vatExemptSales += (totalPrice / (1 + VAT_RATE)) * (1 - discountRate);
      } else if (discountType === 'diplomat') {
        const diplomataBase = totalPrice / (1 + VAT_RATE);
        zeroRatedSales += diplomataBase;
      } else if (discountType === 'regular' && (vatType === 'vatable' || !vatType)) {
        const paxRate = resolveDiscountRate(item, discountType);
        const rawDiscount = item.discount || item.discountSubtotal || 0;
        const effectiveRate = paxRate > 0 ? paxRate : rawDiscount / 100;
        const discountedPrice = totalPrice * (1 - effectiveRate);
        vatableSales += discountedPrice / (1 + VAT_RATE);
        const itemVat = discountedPrice - discountedPrice / (1 + VAT_RATE);
        vatAmount += itemVat;
        salesAdjVatAmount += itemVat;
      } else if (vatType === 'vatable') {
        vatableSales += totalPrice / (1 + VAT_RATE);
        const itemVat = totalPrice - totalPrice / (1 + VAT_RATE);
        vatAmount += itemVat;
        salesAdjVatAmount += itemVat;
      } else if (vatType === 'vatExempt') {
        vatExemptSales += totalPrice;
      } else if (vatType === 'zeroVat') {
        zeroRatedSales += totalPrice / (1 + VAT_RATE);
      }
    }

    const date = Moment.unix(parseInt(key)).format('YYYY-MM-DD');
    const receiptNo = value.receiptNo;
    const receiptCycle = value.receiptCycle ?? 0;
    const totalRefundAmount = vatableSales + vatExemptSales + zeroRatedSales;

    data.push({
      refundKey: key,
      transactionKey: value.originalTransactionKey || value.transactionKey || '',
      date,
      refundNo: value.refundNo || null,
      receiptNo,
      receiptCycle,
      vatableSales,
      vatAmount,
      vatExemptSales,
      zeroRatedSales,
      refundGrandTotal,
      totalRefundAmount,
    });
  });

  const withRefundNo = data
    .map((r) => ({ ...r, effectiveRefundNo: r.refundNo ?? parseInt(String(r.receiptNo)) }))
    .filter((r) => r.effectiveRefundNo != null);
  const sortedByRefundNo = [...withRefundNo].sort(
    (a, b) => (parseInt(String(a.effectiveRefundNo), 10) || 0) - (parseInt(String(b.effectiveRefundNo), 10) || 0)
  );
  const beginningRefundSI = sortedByRefundNo.length
    ? `00-${String(parseInt(String(sortedByRefundNo[0].effectiveRefundNo)) || 0).padStart(6, '0')}`
    : '';
  const endingRefundSI = sortedByRefundNo.length
    ? `00-${String(parseInt(String(sortedByRefundNo[sortedByRefundNo.length - 1].effectiveRefundNo)) || 0).padStart(6, '0')}`
    : '';

  const result: RefundSummaryResult = data as any;
  result.beginningRefundSI = beginningRefundSI;
  result.endingRefundSI = endingRefundSI;
  result.refundsByPaymentType = refundsByPaymentType;
  return result;
};

export interface RefundVatAdjustment {
  sc: number;
  pwd: number;
  mov: number;
  others: number;
  returns: number;
  total: number;
}

/**
 * Per-discount-type VAT adjustment carried by the refunded lines of a period,
 * ported from the mobile app (HelperFunctions/refund.js). The reading's VAT
 * Adjustment block needs these split by discount type; getRefundSummary only
 * reports the combined VAT figure.
 */
export const getRefundVatAdjustment = (snapshot: any): RefundVatAdjustment => {
  let sc = 0;
  let pwd = 0;
  let mov = 0;
  let others = 0;
  let returns = 0;

  if (!snapshot || !snapshot.forEach) return { sc, pwd, mov, others, returns, total: 0 };

  snapshot.forEach((snap: any) => {
    const value = snap.val();
    if (!value?.items || value.trainingMode) return;

    const matchKey =
      value.originalRefundKey != null ? String(value.originalRefundKey) : String(snap.key);
    const isRefundedItem = (item: any) =>
      item != null && item.refund != null && String(item.refund) === matchKey;

    for (const item of (value.items || []).filter(isRefundedItem)) {
      if (!item) continue;
      const totalPrice = (item.price || 0) * Math.abs(item.quantity || 1);
      const baseAmount = totalPrice / (1 + VAT_RATE);
      const itemDiscType = item.individualDiscountType || '';
      const txnDiscType = item.transactionDiscountType || '';
      const discountType = normalizeDiscountType(itemDiscType || txnDiscType);

      if (item.paxDiscount) {
        const guestCount = Object.values(item.paxDiscount as any).reduce(
          (a: number, e: any) => a + (parseInt(e?.guestCount, 10) || 0),
          0,
        );
        if (guestCount <= 0) {
          returns += baseAmount * VAT_RATE;
          continue;
        }
        const isCommodity = item.isCommodity === true;
        for (const [paxDiscType, discObj] of Object.entries(item.paxDiscount as any)) {
          const guestRatio = (parseInt((discObj as any)?.guestCount, 10) || 0) / guestCount;
          const proportionalAmount = baseAmount * guestRatio;
          const discRate =
            (parseFloat((discObj as any)?.percent) || 0) / 100 ||
            (paxDiscType === 'senior' || paxDiscType === 'pwd' || paxDiscType === 'medalOfValor'
              ? SENIOR_RATE
              : paxDiscType === 'ntl'
                ? NAAC_RATE
                : paxDiscType === 'sp'
                  ? SOLO_PARENT_RATE
                  : 0);
          const normalizedPaxType = normalizeDiscountType(paxDiscType);
          if (normalizedPaxType === 'senior' && !isCommodity) {
            sc += proportionalAmount * discRate * VAT_RATE;
          } else if (normalizedPaxType === 'pwd' && !isCommodity) {
            pwd += proportionalAmount * discRate * VAT_RATE;
          } else if (normalizedPaxType === 'medalOfValor' && !isCommodity) {
            mov += proportionalAmount * discRate * VAT_RATE;
          } else if (normalizedPaxType === 'soloParent') {
            others += proportionalAmount * discRate * VAT_RATE;
          } else if (normalizedPaxType === 'ntlAthlete' || normalizedPaxType === 'diplomat') {
            // NAAC stays VATable and diplomat is zero-rated: no VAT adjustment.
          } else if (normalizedPaxType === 'regular' && discRate > 0) {
            others += proportionalAmount * discRate * VAT_RATE;
          }
        }
        continue;
      }

      if (discountType === 'senior') {
        sc += baseAmount * SENIOR_RATE * VAT_RATE;
      } else if (discountType === 'pwd') {
        pwd += baseAmount * PWD_RATE * VAT_RATE;
      } else if (discountType === 'medalOfValor') {
        mov += baseAmount * MEDAL_OF_VALOR_RATE * VAT_RATE;
      } else if (discountType === 'soloParent') {
        others += baseAmount * SOLO_PARENT_RATE * VAT_RATE;
      } else if (discountType === 'ntlAthlete') {
        // NAAC stays VATable: no VAT adjustment.
      } else if (discountType === 'regular') {
        const discount = item.discount || item.discountSubtotal || 0;
        others += baseAmount * (discount / 100) * VAT_RATE;
      } else {
        returns += baseAmount * VAT_RATE;
      }
    }
  });

  const total = sc + pwd + mov + others + returns;
  return { sc, pwd, mov, others, returns, total };
};

interface ReturnSummaryItem {
  key: string;
  originalTransactionKey: string;
  returnNo: number;
  returnAmount: number;
  /** Retail exchange: goods came back, no money left the drawer. */
  isExchange?: boolean;
  receiptNo: string | number;
  receiptCycle: number;
  vatableSales: number;
  vatAmount: number;
  vatExemptSales: number;
  zeroRatedSales: number;
  scReturnDiscount: number;
  pwdReturnDiscount: number;
  movReturnDiscount: number;
  regDiscReturnVat: number;
  zeroRatedReturnBase: number;
  paymentType: string;
}

interface ReturnSummaryResult {
  returns: ReturnSummaryItem[];
  totalReturnAmount: number;
  returnBaseAmount: number;
  cashReturnAmount: number;
  cashReturnNetAmount: number;
  totalReturnVatExemptSales: number;
  count: number;
  totalScReturnDiscount: number;
  totalPwdReturnDiscount: number;
  totalMovReturnDiscount: number;
  scReturnVatAdj: number;
  pwdReturnVatAdj: number;
  movReturnVatAdj: number;
  regDiscReturnVatAdj: number;
  zeroRatedReturnVatAdj: number;
  vatOnReturns: number;
  beginningReturnSI: string;
  endingReturnSI: string;
}

export const getReturnSummary = (snapshot: any): ReturnSummaryResult => {
  const data: ReturnSummaryItem[] = [];
  let totalReturnAmount = 0;

  snapshot.forEach((snap: any) => {
    const key = snap.key;
    const value = snap.val();

    if (value.trainingMode) return;

    // Return records store returnNo at the top level (like void/refund records).
    // This is what X/Z/Custom readings display. Fall back to the nested `returns`
    // mapping only for older records that lack the top-level field.
    let returnNo = Number(value.returnNo) || 0;
    if (!returnNo && value.returns && typeof value.returns === 'object') {
      const returnNos = Object.values(value.returns as any)
        .map(Number)
        .filter((n) => !isNaN(n));
      returnNo = returnNos.length > 0 ? Math.max(...returnNos) : 0;
    }

    let vatableSales = 0;
    let vatAmount = 0;
    let vatExemptSales = 0;
    let zeroRatedSales = 0;
    let returnAmount = 0;
    let scReturnDiscount = 0;
    let pwdReturnDiscount = 0;
    let movReturnDiscount = 0;
    let regDiscReturnVat = 0;
    let zeroRatedReturnBase = 0;

    for (const item of value.items || []) {
      if (!item || !item.returned) continue;

      const totalPriceForPax = (item.price || 0) * Math.abs(item.quantity || 0);
      returnAmount += totalPriceForPax;

      // PAX discount: per-guest classification (mirrors getRefundSummary).
      if (item.paxDiscount && typeof item.paxDiscount === 'object') {
        const guestCount = Object.values(item.paxDiscount as any).reduce(
          (a: number, e: any) => a + (parseInt(e?.guestCount, 10) || 0),
          0,
        );
        if (guestCount > 0) {
          const isCommodity = item.isCommodity === true;
          const baseAmountPax = totalPriceForPax / (1 + VAT_RATE);

          for (const [paxDiscType, discObj] of Object.entries(item.paxDiscount as any)) {
            const seatCount = parseInt((discObj as any)?.guestCount, 10) || 0;
            if (seatCount <= 0) continue;
            const guestRatio = seatCount / guestCount;
            const proportionalBase = baseAmountPax * guestRatio;
            const proportionalGross = totalPriceForPax * guestRatio;
            const normalizedType = normalizeDiscountType(paxDiscType);
            const discRate =
              (parseFloat((discObj as any)?.percent) || 0) / 100 ||
              (normalizedType === 'senior' ||
              normalizedType === 'pwd' ||
              normalizedType === 'medalOfValor'
                ? SENIOR_RATE
                : normalizedType === 'soloParent'
                  ? SOLO_PARENT_RATE
                  : normalizedType === 'ntlAthlete'
                    ? NAAC_RATE
                    : 0);

            if (normalizedType === 'ntlAthlete') {
              vatableSales += proportionalBase * (1 - NAAC_RATE);
              vatAmount += proportionalBase * VAT_RATE;
            } else if (
              ['senior', 'pwd', 'soloParent', 'medalOfValor', 'commodity'].includes(normalizedType)
            ) {
              if (
                isCommodity &&
                (normalizedType === 'senior' ||
                  normalizedType === 'pwd' ||
                  normalizedType === 'medalOfValor')
              ) {
                vatableSales += proportionalBase * (1 - COMMODITY_RATE);
                vatAmount += proportionalBase * (1 - COMMODITY_RATE) * VAT_RATE;
              } else {
                vatExemptSales += proportionalBase * (1 - discRate);
                if (normalizedType === 'senior') {
                  scReturnDiscount += proportionalBase * discRate;
                } else if (normalizedType === 'pwd') {
                  pwdReturnDiscount += proportionalBase * discRate;
                } else if (normalizedType === 'medalOfValor') {
                  movReturnDiscount += proportionalBase * discRate;
                }
              }
            } else if (normalizedType === 'diplomat') {
              zeroRatedSales += proportionalBase;
            } else if (normalizedType === 'regular') {
              const discountedGross = proportionalGross * (1 - discRate);
              const discountedBase = discountedGross / (1 + VAT_RATE);
              vatableSales += discountedBase;
              vatAmount += discountedBase * VAT_RATE;
              if (discRate > 0) {
                regDiscReturnVat += discountedBase * VAT_RATE;
              }
            }
          }
          continue; // PAX item fully handled; skip the non-PAX branches
        }
      }

      // returnAmount was already accumulated above; back it out so the non-PAX
      // path below does not double-add.
      returnAmount -= totalPriceForPax;

      const vatType = item._defaultVatType;
      const discountType = resolveDiscountType(item);
      const itemDiscount = item.discount || 0;
      const txnDiscountPct = item.discountSubtotal || 0;
      const discount = itemDiscount || txnDiscountPct;
      const totalPrice = (item.price || 0) * Math.abs(item.quantity || 0);
      const baseAmount = totalPrice / (1 + VAT_RATE);
      const discountRate = resolveDiscountRate(item, discountType);
      returnAmount += totalPrice;

      const signedTotalPrice = (item.price || 0) * (item.quantity || 0);
      const signedBase = signedTotalPrice / (1 + VAT_RATE);

      // SC/PWD/MOV on a basic necessity (bnpc.ts): returned like a regular
      // discount (VATable on the discounted base), at the line's own rate, and
      // kept out of the SC/PWD/MOV VAT-exempt return figures. Mirrors the device.
      const bnpcRate = bnpcLineRate(item, discountType);
      if (bnpcRate != null) {
        if (vatType === 'vatable') {
          const discountedBase = signedBase * (1 - bnpcRate);
          vatableSales += discountedBase;
          vatAmount += discountedBase * VAT_RATE;
          if (bnpcRate > 0) {
            regDiscReturnVat += Math.abs(discountedBase) * VAT_RATE;
          }
        } else if (vatType === 'vatExempt') {
          vatExemptSales += signedTotalPrice;
        } else if (vatType === 'zeroVAT') {
          zeroRatedSales += signedTotalPrice / (1 + VAT_RATE);
        }
        continue;
      }

      if (
        vatType === 'vatable' &&
        !['senior', 'pwd', 'soloParent', 'medalOfValor', 'diplomat'].includes(discountType)
      ) {
        if (discountType === 'ntlAthlete') {
          vatableSales += signedBase * (1 - NAAC_RATE);
          vatAmount += signedBase * VAT_RATE;
        } else if (discountType === 'regular') {
          const effectiveRate = discountRate > 0 ? discountRate : discount / 100;
          const discountedBase = signedBase * (1 - effectiveRate);
          vatableSales += discountedBase;
          vatAmount += discountedBase * VAT_RATE;
          if (effectiveRate > 0) {
            regDiscReturnVat += Math.abs(discountedBase) * VAT_RATE;
          }
        } else {
          vatableSales += signedBase;
          vatAmount += signedBase * VAT_RATE;
        }
      }

      if (
        vatType === 'vatExempt' ||
        ['senior', 'pwd', 'soloParent', 'medalOfValor'].includes(discountType)
      ) {
        const exemptAmount =
          vatType === 'vatExempt'
            ? signedTotalPrice
            : discountType === 'soloParent'
              ? signedBase * (1 - SOLO_PARENT_RATE)
              : signedBase * (1 - discountRate);
        vatExemptSales += exemptAmount;
        if (discountType === 'senior') {
          scReturnDiscount += Math.abs(baseAmount) * discountRate;
        } else if (discountType === 'pwd') {
          pwdReturnDiscount += Math.abs(baseAmount) * discountRate;
        } else if (discountType === 'medalOfValor') {
          movReturnDiscount += Math.abs(baseAmount) * discountRate;
        }
      }

      if (
        discountType === 'diplomat' ||
        (vatType === 'zeroVAT' &&
          !['senior', 'pwd', 'soloParent', 'medalOfValor'].includes(discountType))
      ) {
        const zrBase = signedTotalPrice / (1 + VAT_RATE);
        zeroRatedSales += zrBase;
      }
    }

    totalReturnAmount += returnAmount;
    const paymentType = value.paymentType || 'Cash';
    const receiptNo = value.receiptNo;
    const receiptCycle = value.receiptCycle ?? 0;

    data.push({
      key,
      originalTransactionKey: value.originalTransactionKey || value.transactionKey || '',
      returnNo,
      returnAmount,
      receiptNo,
      receiptCycle,
      vatableSales,
      vatAmount,
      vatExemptSales,
      zeroRatedSales,
      scReturnDiscount,
      pwdReturnDiscount,
      movReturnDiscount,
      regDiscReturnVat,
      zeroRatedReturnBase,
      paymentType,
      // Retail exchange (utakretailBIR): the credit paid for the replacement
      // sale, so no money left the drawer. Kept out of the cash returns below.
      isExchange: !!value.isExchange,
    });
  });

  const withReturnNo = data
    .map((r) => ({ ...r, effectiveReturnNo: r.returnNo ?? parseInt(String(r.receiptNo)) }))
    .filter((r) => r.effectiveReturnNo != null);
  const sortedByReturnNo = [...withReturnNo].sort(
    (a, b) => (parseInt(String(a.effectiveReturnNo), 10) || 0) - (parseInt(String(b.effectiveReturnNo), 10) || 0)
  );
  const beginningReturnSI = sortedByReturnNo.length
    ? `00-${String(parseInt(String(sortedByReturnNo[0].effectiveReturnNo)) || 0).padStart(6, '0')}`
    : '';
  const endingReturnSI = sortedByReturnNo.length
    ? `00-${String(parseInt(String(sortedByReturnNo[sortedByReturnNo.length - 1].effectiveReturnNo)) || 0).padStart(6, '0')}`
    : '';

  const totalScReturnDiscount = data.reduce((s, r) => s + (r.scReturnDiscount || 0), 0);
  const totalPwdReturnDiscount = data.reduce((s, r) => s + (r.pwdReturnDiscount || 0), 0);
  const totalMovReturnDiscount = data.reduce((s, r) => s + (r.movReturnDiscount || 0), 0);
  const totalRegDiscReturnVat = data.reduce((s, r) => s + (r.regDiscReturnVat || 0), 0);
  const totalZeroRatedReturnBase = data.reduce((s, r) => s + (r.zeroRatedReturnBase || 0), 0);
  const vatOnReturns = data.reduce((s, r) => s + (r.vatAmount || 0), 0);
  const returnBaseAmount = data.reduce((sum, r) => sum + r.vatableSales + r.vatExemptSales + r.zeroRatedSales, 0);
  const cashReturnAmount = data
    .filter((r) => r.paymentType === 'Cash' && !r.isExchange)
    .reduce((sum, r) => sum + (r.returnAmount || 0), 0);
  const cashReturnNetAmount = data
    .filter((r) => r.paymentType === 'Cash' && !r.isExchange)
    .reduce((sum, r) => {
      const base = Math.abs((r.vatableSales || 0) + (r.vatExemptSales || 0) + (r.zeroRatedSales || 0));
      return (
        sum +
        (base - (r.scReturnDiscount || 0) - (r.pwdReturnDiscount || 0) - (r.movReturnDiscount || 0))
      );
    }, 0);
  const totalReturnVatExemptSales = data.reduce((s, r) => s + Math.abs(r.vatExemptSales || 0), 0);

  return {
    returns: data,
    totalReturnAmount,
    returnBaseAmount,
    cashReturnAmount,
    cashReturnNetAmount,
    totalReturnVatExemptSales,
    count: data.length,
    totalScReturnDiscount,
    totalPwdReturnDiscount,
    totalMovReturnDiscount,
    scReturnVatAdj: totalScReturnDiscount * (VAT_RATE / SENIOR_RATE),
    pwdReturnVatAdj: totalPwdReturnDiscount * (VAT_RATE / PWD_RATE),
    movReturnVatAdj: totalMovReturnDiscount * (VAT_RATE / MEDAL_OF_VALOR_RATE),
    regDiscReturnVatAdj: totalRegDiscReturnVat,
    zeroRatedReturnVatAdj: totalZeroRatedReturnBase * VAT_RATE,
    vatOnReturns,
    beginningReturnSI,
    endingReturnSI,
  };
};

interface VoidSummaryItem {
  key: string;
  amount: number;
  paymentType: string;
  voidBase: number;
  voidVat: number;
  voidNo?: number | null;
  receiptNo?: string | number;
  receiptCycle: number;
  reason: string;
  cashier: string;
  timestamp: number;
  originalTransactionKey: string;
  isCancel?: boolean;
  isCrossDay?: boolean;
}

interface VoidSummaryResult {
  totalVoids: number;
  totalVoidBase: number;
  totalVoidVat: number;
  voids: VoidSummaryItem[];
  count: number;
  beginningVoidSI: string;
  endingVoidSI: string;
}

export const getVoidSummary = (voidsSnapshot: any): VoidSummaryResult => {
  let totalVoids = 0;
  let totalVoidBase = 0;
  let totalVoidVat = 0;
  const voids: VoidSummaryItem[] = [];

  if (voidsSnapshot && voidsSnapshot.forEach) {
    voidsSnapshot.forEach((voidTxn: any) => {
      const data = voidTxn.val();
      const voidKey = voidTxn.key;

      if (data.trainingMode) return;

      let isCrossDay = false;
      if (data.originalTransactionKey) {
        const voidDate = Moment.unix(parseInt(voidKey)).format('YYYY-MM-DD');
        const originalTxnDate = Moment.unix(parseInt(data.originalTransactionKey)).format('YYYY-MM-DD');
        if (voidDate !== originalTxnDate) {
          isCrossDay = true;
        }
      }

      if (data.isCancel) {
        voids.push({
          key: voidKey,
          amount: parseFloat(data.amount) || 0,
          paymentType: data.paymentType || 'Cash',
          voidBase: 0,
          voidVat: 0,
          voidNo: data.voidNo ?? null,
          receiptNo: data.receiptNo ?? '',
          receiptCycle: data.receiptCycle != null ? parseInt(data.receiptCycle, 10) : 0,
          reason: data.reason || '',
          cashier: data.cashier || '',
          timestamp: data.timestamp || 0,
          originalTransactionKey: data.originalTransactionKey || '',
          isCancel: true,
        });
        return;
      }

      const amount = parseFloat(data.amount) || 0;
      let voidBase = 0;
      let voidVat = 0;

      const items = data.items || [];
      if (items.length > 0) {
        for (const item of items) {
          if (!item) continue;
          const vatType = item._defaultVatType
            ? item._defaultVatType
            : item.zeroVAT
              ? 'vatExempt'
              : 'vatable';
          const totalPrice = (item.price || 0) * Math.abs(item.quantity || 1);
          const base = totalPrice / (1 + VAT_RATE);

          const pax = item?.paxDiscount;
          if (pax && typeof pax === 'object' && Object.keys(pax).length > 0) {
            const guestCount = Object.values(pax as any).reduce(
              (a: number, e: any) => a + (parseInt(e?.guestCount, 10) || 0),
              0
            );
            if (guestCount > 0) {
              for (const [paxDiscType, discObj] of Object.entries(pax as any)) {
                const seatCount = parseInt((discObj as any)?.guestCount, 10) || 0;
                if (seatCount <= 0) continue;
                const guestRatio = seatCount / guestCount;
                const proportionalBase = base * guestRatio;
                const discountType = normalizeVoidPaxType(paxDiscType);

                if (discountType === 'ntlAthlete') {
                  voidBase += proportionalBase * (1 - NAAC_RATE);
                  voidVat += proportionalBase * VAT_RATE;
                } else if (
                  ['senior', 'pwd', 'soloParent', 'medalOfValor'].includes(discountType)
                ) {
                  const discountRate =
                    discountType === 'senior'
                      ? SENIOR_RATE
                      : discountType === 'pwd'
                        ? PWD_RATE
                        : discountType === 'medalOfValor'
                          ? MEDAL_OF_VALOR_RATE
                          : SOLO_PARENT_RATE;
                  voidBase += proportionalBase * (1 - discountRate);
                } else if (discountType === 'diplomat') {
                  voidBase += proportionalBase;
                } else if (discountType === 'regular') {
                  const discRate = (parseFloat((discObj as any)?.percent) || 0) / 100;
                  const discountedBase = proportionalBase * (1 - discRate);
                  voidBase += discountedBase;
                  voidVat += discountedBase * VAT_RATE;
                }
              }
              continue;
            }
          }

          const discountType = resolveDiscountType(item);
          // SC/PWD/MOV on a basic necessity (bnpc.ts): voided like a regular
          // discount, at the line's own rate. Mirrors the device.
          const bnpcRate = bnpcLineRate(item, discountType);
          if (bnpcRate != null && vatType === 'vatable') {
            const discountedBase = base * (1 - bnpcRate);
            voidBase += discountedBase;
            voidVat += discountedBase * VAT_RATE;
          } else if (bnpcRate != null && vatType === 'vatExempt') {
            voidBase += totalPrice;
          } else if (bnpcRate != null && vatType === 'zeroVAT') {
            voidBase += base;
          } else if (bnpcRate != null) {
            // Unknown VAT type: same as a regular discount here (nothing booked).
          } else if (
            vatType === 'vatable' &&
            !['senior', 'pwd', 'soloParent', 'medalOfValor', 'ntlAthlete', 'diplomat'].includes(
              discountType,
            )
          ) {
            if (discountType === 'regular') {
              const paxRate = resolveDiscountRate(item, discountType);
              const rawDiscount = item.discount || item.discountSubtotal || 0;
              const effectiveRate = paxRate > 0 ? paxRate : rawDiscount / 100;
              const discountedBase = base * (1 - effectiveRate);
              voidBase += discountedBase;
              voidVat += discountedBase * VAT_RATE;
            } else {
              voidBase += base;
              voidVat += base * VAT_RATE;
            }
          } else if (vatType === 'vatable' && discountType === 'ntlAthlete') {
            voidBase += base * (1 - NAAC_RATE);
            voidVat += base * VAT_RATE;
          } else if (
            vatType === 'vatExempt' ||
            ['senior', 'pwd', 'soloParent', 'medalOfValor'].includes(discountType)
          ) {
            const discountRate = resolveDiscountRate(item, discountType);
            const exemptAmount =
              vatType === 'vatExempt'
                ? totalPrice
                : ['senior', 'pwd', 'soloParent', 'medalOfValor'].includes(discountType)
                  ? base * (1 - discountRate)
                  : base;
            voidBase += exemptAmount;
          } else if (
            discountType === 'diplomat' ||
            (vatType === 'zeroVAT' &&
              !['senior', 'pwd', 'soloParent', 'medalOfValor'].includes(discountType))
          ) {
            voidBase += base;
          }
        }
      } else {
        voidBase = amount / (1 + VAT_RATE);
        voidVat = amount - voidBase;
      }

      totalVoids += amount;
      totalVoidBase += roundMoney(voidBase * 100) / 100;
      totalVoidVat += roundMoney(voidVat * 100) / 100;
      const receiptNo = data.receiptNo != null ? parseInt(data.receiptNo, 10) : null;
      const receiptCycle = data.receiptCycle != null ? parseInt(data.receiptCycle, 10) : 0;
      voids.push({
        key: voidKey,
        amount,
        paymentType: data.paymentType || 'Cash',
        voidBase,
        voidVat,
        voidNo: data.voidNo || null,
        receiptNo: data.receiptNo ?? '',
        receiptCycle,
        reason: data.reason || '',
        cashier: data.cashier || '',
        timestamp: data.timestamp || 0,
        originalTransactionKey: data.originalTransactionKey || '',
        isCrossDay,
      });
    });
  }

  const regularVoids = voids.filter((v) => !v.isCancel);
  const withVoidNo = regularVoids
    .map((v) => ({ ...v, effectiveVoidNo: v.voidNo ?? parseInt(String(v.key)) }))
    .filter((v) => v.effectiveVoidNo != null);
  const sortedByVoidNo = [...withVoidNo].sort(
    (a, b) => (parseInt(String(a.effectiveVoidNo), 10) || 0) - (parseInt(String(b.effectiveVoidNo), 10) || 0)
  );
  const beginningVoidSI = sortedByVoidNo.length
    ? `00-${String(parseInt(String(sortedByVoidNo[0].effectiveVoidNo)) || 0).padStart(6, '0')}`
    : '';
  const endingVoidSI = sortedByVoidNo.length
    ? `00-${String(parseInt(String(sortedByVoidNo[sortedByVoidNo.length - 1].effectiveVoidNo)) || 0).padStart(6, '0')}`
    : '';

  return {
    totalVoids,
    totalVoidBase,
    totalVoidVat,
    voids,
    count: voids.length,
    beginningVoidSI,
    endingVoidSI,
  };
};
