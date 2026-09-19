import Moment from 'moment-timezone';

import { calcReadingData } from './calcReadingData';
import { ACCUMULATED_SALES_RESET_THRESHOLD, getAllTendersFrom } from './reading';
import { alignMiddle, alignRight, fixnum, newline, normalize, bold, pipe } from './format';

/**
 * Print a payment row, wrapping a tender name too long for the label column
 * instead of truncating it to its first two words.
 */
const paymentLine = (
  label: string,
  value: number,
  width: number,
  sa: (t: string) => string,
  ss: (t: string) => string,
  money: (n: number) => string,
): string => {
  if (label.length + 1 <= width) return sa(`${label}:`) + ss(money(value));

  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > width ? word.slice(0, width) : word;
    }
  }
  if (current) lines.push(current);

  let out = '';
  for (let i = 0; i < lines.length - 1; i++) out += sa(lines[i]);
  return out + sa(`${lines[lines.length - 1]}:`) + ss(money(value));
};

/** Built-in tender rows. `showAtZero` keeps a spurious "CHEQUE: 0.00" off the slip. */
export const BUILT_IN_TENDER_ROWS: ReadonlyArray<{ name: string; showAtZero: boolean }> = [
  { name: 'GCash', showAtZero: true },
  { name: 'Maya', showAtZero: true },
  { name: 'Credit Card', showAtZero: true },
  { name: 'Debit Card', showAtZero: true },
  { name: 'Check', showAtZero: false },
  { name: 'Gift Check', showAtZero: false },
  { name: 'Gift Card', showAtZero: true },
];

/** Matching key for a tender name. Mirrors the tender catalog's own comparison. */
const canonicalTenderKey = (name: unknown): string =>
  String(name == null ? '' : name).trim().toLowerCase();

/**
 * Every tender row a reading should print, in a stable order.
 *
 * `nonCashPayments` is keyed by whatever tender names the transactions in the
 * range happened to carry, so a bare `for...in` both emits the lines in arrival
 * order — GrabFood above FoodPanda on one reading and below it on the next —
 * and omits any method that took no money at all. BIR's tester reported the
 * second half of that: "if the other payment methods are not used, it's not
 * showing up even as ZERO".
 *
 * So this is a UNION, not a filter. The result is: built-ins in
 * BUILT_IN_TENDER_ROWS order, then every configured tender in configured order,
 * then any remaining data key in arrival order.
 *
 * No amount moves. Every key present in `nonCashPayments` is returned exactly
 * once and keeps its own spelling, so each lookup still finds its own figure. A
 * catalog name only contributes a row when NO data key matches it
 * case-insensitively, which stops a wallet picker's 'Gcash' rendering beside a
 * seeded 'GCash' as two rows. Two data keys differing only by case stay two rows
 * on purpose — merging them would change a printed figure.
 */
export const orderNonCashPaymentKeys = (
  nonCashPayments: Record<string, any> | null | undefined,
  settings?: any,
): string[] => {
  const dataKeys = Object.keys(nonCashPayments || {});
  const dataByCanonical = new Map<string, string[]>();
  for (const key of dataKeys) {
    const canonical = canonicalTenderKey(key);
    if (!canonical) continue;
    const bucket = dataByCanonical.get(canonical);
    if (bucket) bucket.push(key);
    else dataByCanonical.set(canonical, [key]);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const take = (name: unknown, showAtZero: boolean) => {
    const canonical = canonicalTenderKey(name);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    const withData = dataByCanonical.get(canonical);
    if (withData) ordered.push(...withData);
    else if (showAtZero) ordered.push(String(name).trim());
  };

  BUILT_IN_TENDER_ROWS.forEach((t) => take(t.name, t.showAtZero));
  getAllTendersFrom(settings).forEach((t: any) => take(t && t.name, true));
  // Whatever is left keeps its original relative order.
  dataKeys.forEach((key) => take(key, true));
  return ordered;
};

/**
 * Renders a BIR X/Z/Custom reading as receipt text. Faithful port of the mobile
 * app's reading() (utakmobileBIR/src/mod_temp_bir/receipts/reading.ts), with the
 * settings observable replaced by an explicit `settings` argument.
 */
export function renderReading(
  args: any,
  settings: any,
): string {
  const {
    type,
    txnSummary,
    refundSummary,
    returnSummary,
    withdrawalSummary,
    voidSummary,
    resetCounter,
    cashdrawer = {},
    cashier,
    posTerminalNumber,
    dateRange,
    sttS,
    endS,
    previousAccSales,
    accumulatedSalesResetTriggered = false,
    reprint = false,
    zReadNo,
    cashDeclaration,
    lastReceiptInfo = null,
    lastVoidSIInfo = null,
    lastReturnSIInfo = null,
    lastRefundSIInfo = null,
    title = null,
  } = args;

  const {
    beginningCI,
    endingCI,
    beginningCICycle,
    endingCICycle,
    vatableSales,
    vatAmount,
    vatExemptSales,
    zeroRatedSales,
    grossSales,
    grossSalesBeforeDiscount,
    lessDiscount,
    lessReturn,
    lessVoid,
    lessVatAdjustment,
    scDiscount,
    pwdDiscount,
    naacDiscount,
    soloParentDiscount,
    medalOfValorDiscount,
    othersDiscount,
    othersTrans,
    vatOnReturns,
    nonCashPayments,
    serviceCharge,
    refundTotal,
    refundNetAmount,
    refundBaseAmount,
    refundSalesAdjustmentAmount,
    cashTendered,
    scVatAdj,
    pwdVatAdj,
    soloParentVatAdj,
    medalOfValorVatAdj,
    zeroRatedVatAdj,
  } = calcReadingData(txnSummary, refundSummary, returnSummary, voidSummary, lastReceiptInfo);

  const hasVoidActivity = !!((voidSummary as any)?.beginningVoidSI || (voidSummary as any)?.endingVoidSI);
  const hasReturnActivity = !!((returnSummary as any)?.beginningReturnSI || (returnSummary as any)?.endingReturnSI);

  const beginningVoidSI: string = (voidSummary as any)?.beginningVoidSI || (hasVoidActivity ? '' : (lastVoidSIInfo as any)?.beginningVoidSI || '');
  const endingVoidSI: string = (voidSummary as any)?.endingVoidSI || (hasVoidActivity ? '' : (lastVoidSIInfo as any)?.endingVoidSI || '');
  const beginningRefundSI: string = (refundSummary as any)?.beginningRefundSI || (lastRefundSIInfo as any)?.beginningRefundSI || '';
  const endingRefundSI: string = (refundSummary as any)?.endingRefundSI || (lastRefundSIInfo as any)?.endingRefundSI || '';
  const beginningReturnSI: string = (returnSummary as any)?.beginningReturnSI || (hasReturnActivity ? '' : (lastReturnSIInfo as any)?.beginningReturnSI || '');
  const endingReturnSI: string = (returnSummary as any)?.endingReturnSI || (hasReturnActivity ? '' : (lastReturnSIInfo as any)?.endingReturnSI || '');

  const name = (settings.name || '').split(',');
  const address = (settings.address || '').split(',');
  const bir = {
    enabled: settings.receiptDetails?.BIR,
    receiptType: 'OR',
    nonVatTin: '',
    vatTin: '',
    min: '',
    sn: '',
    permitNo: '',
    permitSttDate: '',
    permitEndDate: '',
  };

  if (bir.enabled) {
    const d = settings.receiptDetails!;
    bir.receiptType = d.receiptType || 'OR';
    if (d.VATTIN) bir.vatTin = d.VATTIN;
    else if (d.NONVATTIN) bir.nonVatTin = d.NONVATTIN;
    if (d.MIN) bir.min = d.MIN;
    if (d.SN) bir.sn = d.SN;
    if (d.permitNo) bir.permitNo = d.permitNo;
    const time = Moment(settings.BIRStartDate || '2023-03-16', 'YYYY-MM-DD');
    bir.permitSttDate = time.format('MM/DD/YYYY');
    bir.permitEndDate = time.add(5, 'years').subtract(1, 'day').format('MM/DD/YYYY');
  }

  const miniprinter = settings.miniprinter;
  const businessStyle = settings.businessStyle || '';
  const ownerName = settings.ownerName || '';

  const lineWidth = miniprinter ? 37 : 47;

  const mm = pipe(normalize, (out: string) => alignMiddle(out, lineWidth), newline);
  const mmBold = pipe(bold, normalize, (out: string) => alignMiddle(out, lineWidth), newline);

  const S = 22;
  const sa = (out: string) => out.padStart(S, ' ');
  const ss = pipe(normalize, (out: string) => alignRight(out, lineWidth - S), newline);

  const _money = (v: number | string) => fixnum(Math.round(Number(v) * 100) / 100, { long: true });
  const padReceiptNo = (cycle: number | string, out: number | string) => {
    const c = String(cycle || 0).padStart(2, '0');
    const n6 = ('' + out).padStart(6, '0');
    return `${c}-${n6}`;
  };

  let out = '';

  const isTraining = (globalThis as any).isInTrainingMode || (globalThis as any).appMode === 'training';
  if (isTraining) {
    out += mm('*** TRAINING MODE ***');
    out += mm('*** NOT FOR OFFICIAL USE ***');
    out += mm('*** TRAINING PURPOSES ONLY ***');
    out += '\n';
  }

  for (let i = 0; i < Math.min(name.length, 4); i++) out += mmBold(name[i]);
  if (businessStyle) out += mm(businessStyle);
  if (ownerName) {
    out += mm('Operated By: ');
    out += mm(ownerName);
    out += '\n';
  }
  for (let i = 0; i < Math.min(address.length, 4); i++) out += mm(address[i]);
  out += '\n';

  if (bir.enabled) {
    if (bir.nonVatTin) out += mm(`NON VAT REG TIN: ${bir.nonVatTin}`);
    else if (bir.vatTin) out += mm(`VAT REG TIN: ${bir.vatTin}`);
    if (bir.min) out += mm(`MIN: ${bir.min}`);
    if (bir.sn) out += mm(`SN: ${bir.sn}`);
    out += '\n';
  }

  if (reprint && type === 'X') {
    out += mm('*** REPRINT ***');
    const reprintCount = typeof reprint === 'number' ? reprint : 1;
    out += mm(`Reprint #${reprintCount}`);
    out += mm(`Reprint Date: ${Moment().format('MM/DD/YYYY HH:mm:ss')}`);
  }

  out += mmBold(title || `${type}-READING REPORT`);
  if (reprint && type !== 'X') {
    out += mm('*** REPRINT ***');
    const reprintCount = typeof reprint === 'number' ? reprint : 1;
    out += mm(`Reprint #${reprintCount}`);
    out += mm(`Reprint Date: ${Moment().format('MM/DD/YYYY HH:mm:ss')}`);
  }

  let reportDateStr: string;
  let reportTimeStr: string;
  if (reprint && (dateRange || (typeof sttS === 'number' && typeof endS === 'number'))) {
    const endMoment = dateRange
      ? Moment(dateRange.end, 'MM/DD/YYYY').endOf('day')
      : typeof endS === 'number'
        ? Moment.unix(endS)
        : Moment();
    reportDateStr = endMoment.format('MM/DD/YYYY');
    reportTimeStr = endMoment.format('HH:mm:ss');
  } else {
    reportDateStr = Moment().format('MM/DD/YYYY');
    reportTimeStr = Moment().format('HH:mm:ss');
  }
  out += sa('Report Date:') + ss(reportDateStr);
  out += sa('Report Time:') + ss(reportTimeStr);
  out += '\n';

  const startDateTime = typeof sttS === 'number'
    ? Moment.unix(sttS).format('MM/DD/YYYY HH:mm:ss')
    : dateRange
      ? `${dateRange.start} 00:00:00`
      : `${Moment().startOf('day').format('MM/DD/YYYY')} 00:00:00`;
  const endDateTime = typeof endS === 'number'
    ? Moment.unix(endS).format('MM/DD/YYYY HH:mm:ss')
    : Moment().format('MM/DD/YYYY HH:mm:ss');

  out += sa('Start Date & Time:') + ss(startDateTime);
  out += sa('End Date & Time:') + ss(endDateTime);
  out += '\n';

  let totalGiftCardOver = 0;
  if (Array.isArray(txnSummary)) {
    txnSummary.forEach((txn: any) => {
      totalGiftCardOver += Number(txn.giftCardOverAmount) || 0;
    });
  }
  const displayGiftCardOver = Math.max(0, totalGiftCardOver);
  const effectiveCashTendered = Number(cashTendered ?? cashdrawer?.cashSales ?? 0) || 0;

  if (type === 'X') {
    const openingFund = Number(cashdrawer?.startingCash ?? 0) || 0;
    const addedCash = Number(cashdrawer?.addedCash ?? 0) || 0;
    const lessVoidActual =
      (voidSummary?.totalVoidBase != null ? voidSummary.totalVoidBase : null) ??
      voidSummary?.totalVoids ?? lessVoid ?? 0;
    const lessRefundAmount = Math.abs(Number(refundNetAmount ?? refundSalesAdjustmentAmount ?? refundBaseAmount ?? refundTotal) || 0);
    const cancelledAmount = Array.isArray(voidSummary?.voids)
      ? voidSummary.voids.reduce((sum: number, v: any) => sum + (v?.isCancel ? Math.abs(Number(v?.amount) || 0) : 0), 0)
      : 0;
    const voidedAmount = Math.abs(Number(voidSummary?.totalVoids ?? lessVoidActual) || 0);
    const refundedAmount = Array.isArray(refundSummary)
      ? Math.abs(refundSummary.reduce((sum: number, refund: any) => sum + (Number(refund?.refundGrandTotal ?? refund?.total ?? refund?.totalRefundAmount) || 0), 0))
      : Math.abs(lessRefundAmount || 0);
    const returnedAmount = Math.abs(Number(returnSummary?.totalReturnAmount ?? lessReturn) || 0);
    const totalPaymentsSeparator = '='.repeat(44);

    if (cashier) out += sa('Cashier:') + ss(cashier);
    if (posTerminalNumber) out += sa('POS Terminal #:') + ss(posTerminalNumber);
    out += sa(`Beg. ${bir.receiptType} #:`) + ss(padReceiptNo(beginningCICycle, beginningCI));
    out += sa(`End. ${bir.receiptType} #:`) + ss(padReceiptNo(endingCICycle, endingCI));
    out += sa('Beginning VOID #') + ss(beginningVoidSI || padReceiptNo(0, 0));
    out += sa('Ending VOID #') + ss(endingVoidSI || padReceiptNo(0, 0));
    out += sa('Beginning RETURN #') + ss(beginningReturnSI || padReceiptNo(0, 0));
    out += sa('Ending RETURN #') + ss(endingReturnSI || padReceiptNo(0, 0));
    out += sa('Beginning REFUND #') + ss(beginningRefundSI || padReceiptNo(0, 0));
    out += sa('Ending REFUND #') + ss(endingRefundSI || padReceiptNo(0, 0));
    out += '\n';
    out += sa('Opening Fund:') + ss(_money(openingFund));
    out += mm(totalPaymentsSeparator);
    out += mmBold('PAYMENTS RECEIVED');
    // Payments Received should reflect net kept payments after reversals.
    const paymentsReceivedCash = Math.max(0, effectiveCashTendered);
    // Built-ins first (always shown, including zeros), then merchant-defined
    // tenders in configured order, then anything else that turned up — a tender
    // that has since been deactivated still has to render on a historical read.
    // The zero rows and the ordering both come from orderNonCashPaymentKeys, so
    // this block and the TRANSACTION SUMMARY below print the same set of tenders
    // in the same sequence.
    const orderedTenderKeys = orderNonCashPaymentKeys(nonCashPayments, settings);
    const allPaymentTotals: Record<string, number> = { Cash: paymentsReceivedCash };
    for (const key of orderedTenderKeys) {
      allPaymentTotals[key] = Number((nonCashPayments || {})[key]) || 0;
    }

    const orderedPaymentKeys = ['Cash', ...orderedTenderKeys];

    if (displayGiftCardOver > 0) {
      allPaymentTotals['Excess GC'] = displayGiftCardOver;
      orderedPaymentKeys.push('Excess GC');
    }

    for (const payment of orderedPaymentKeys) {
      const value = Number(allPaymentTotals[payment]) || 0;
      const paymentLabel = payment.toUpperCase() === 'CHECK' ? 'CHEQUE' : payment.toUpperCase();
      out += paymentLine(paymentLabel, value, S, sa, ss, _money);
    }
    const totalPayments = Math.round(orderedPaymentKeys.reduce((sum, k) => sum + (Number(allPaymentTotals[k]) || 0), 0) * 100) / 100;
    out += sa('Total Payments:') + ss(_money(totalPayments));
    out += mm(totalPaymentsSeparator);
    out += sa('CANCELLED') + ss(_money(cancelledAmount));
    out += mm(totalPaymentsSeparator);
    out += sa('VOIDED') + ss(_money(voidedAmount));
    out += mm(totalPaymentsSeparator);
    out += sa('REFUNDED') + ss(_money(refundedAmount));
    out += mm(totalPaymentsSeparator);
    out += sa('RETURNED') + ss(_money(returnedAmount));
    out += mm(totalPaymentsSeparator);
    out += sa('SERVICE CHARGE') + ss(_money(serviceCharge));
    out += mm(totalPaymentsSeparator);

    out += mmBold('TRANSACTION SUMMARY');
    out += sa('Opening Fund:') + ss(_money(openingFund));
    out += sa('Cash Added:') + ss(_money(addedCash));
    out += sa('Cash Tendered:') + ss(_money(effectiveCashTendered));
    for (const payment of orderNonCashPaymentKeys(nonCashPayments, settings)) {
      if (payment === 'Gift Card') continue;
      const value = Number(nonCashPayments[payment]) || 0;
      const paymentLabel = payment.toUpperCase() === 'CHECK' ? 'CHEQUE' : payment.toUpperCase() === 'GIFT CHECK' ? 'GIFT CHECK' : payment;
      out += paymentLine(paymentLabel, value, S, sa, ss, _money);
    }
    // Gift Card is a checkout button like Credit Card, and PAYMENTS RECEIVED
    // above has always printed it at 0.00; hiding it two blocks later on the
    // same slip is exactly the inconsistency the tester reported. Unconditional
    // now, still in its own slot (skipped by the loop) so the row does not move.
    const consumedGCX = Number(nonCashPayments['Gift Card']) || 0;
    out += sa('Gift Card:') + ss(_money(consumedGCX));
    out += sa('Excess GC:') + ss(_money(displayGiftCardOver));
    const xComputedEnding = Math.round((openingFund + addedCash + effectiveCashTendered + displayGiftCardOver) * 100) / 100;
    out += sa('Ending Balance:') + ss(_money(xComputedEnding));
    out += mm(totalPaymentsSeparator);
  } else {
    if (cashier) out += sa('Cashier:') + ss(cashier);
    if (posTerminalNumber) out += sa('POS Terminal #:') + ss(posTerminalNumber);
    out += sa(`Beginning SI #`) + ss(padReceiptNo(beginningCICycle, beginningCI));
    out += sa(`Ending SI #`) + ss(padReceiptNo(endingCICycle, endingCI));
    out += sa('Beginning VOID #') + ss(beginningVoidSI || padReceiptNo(0, 0));
    out += sa('Ending VOID #') + ss(endingVoidSI || padReceiptNo(0, 0));
    out += sa('Beginning RETURN #') + ss(beginningReturnSI || padReceiptNo(0, 0));
    out += sa('Ending RETURN #') + ss(endingReturnSI || padReceiptNo(0, 0));
    out += sa('Beginning REFUND #') + ss(beginningRefundSI || padReceiptNo(0, 0));
    out += sa('Ending REFUND #') + ss(endingRefundSI || padReceiptNo(0, 0));
    out += '\n';

    out += sa('Reset Counter No.:') + ss(String(resetCounter ?? 0).padStart(2, '0'));
    if (zReadNo != null && zReadNo !== '') {
      out += sa('Z Counter:') + ss(String(zReadNo).padStart(12, '0'));
    }
    out += mm('-'.repeat(30));

    const computedVoidBase = Array.isArray((voidSummary as any)?.voids)
      ? (voidSummary as any).voids.reduce((sum: number, v: any) => sum + (Number(v?.voidBase ?? 0) || 0), 0)
      : null;
    const lessVoidActual =
      ((computedVoidBase != null ? computedVoidBase : null) ??
        (voidSummary?.totalVoidBase != null ? voidSummary.totalVoidBase : null) ??
        voidSummary?.totalVoids ?? lessVoid ?? 0);
    const lessRefundAmount = Math.abs(Number(refundNetAmount ?? refundSalesAdjustmentAmount ?? refundBaseAmount ?? refundTotal) || 0);
    const refundVatReturns = refundSummary?.reduce?.((sum: number, refund: any) => sum + (refund?.vatAmount || 0), 0) || 0;
    const voidVatAdj = Array.isArray((voidSummary as any)?.voids)
      ? (voidSummary as any).voids.reduce((sum: number, v: any) => sum + (Number(v?.voidVat ?? 0) || 0), 0)
      : (Number(voidSummary?.totalVoidVat ?? 0) || 0);
    const totalLessVatAdj = Number(lessVatAdjustment);
    const deductionsWithoutVatAdj =
      Math.abs(Number(lessDiscount)) + Math.abs(lessVoidActual) + Math.abs(Number(lessReturn)) + lessRefundAmount;
    const grossBase = Number(grossSalesBeforeDiscount) || Number(grossSales);
    const headroom = grossBase - deductionsWithoutVatAdj;
    const lessVatAdjToApply = headroom >= 0 ? Math.min(totalLessVatAdj, headroom) : 0;
    const netSalesForDay = Math.max(0, Math.round((grossBase - deductionsWithoutVatAdj - lessVatAdjToApply) * 100) / 100);

    const rawPrevAcc = Number(previousAccSales) || 0;
    const grossNum = Number(grossSalesBeforeDiscount) || 0;
    const totalAccRounded = Math.round((rawPrevAcc + grossNum) * 100) / 100;
    const wouldHitReset = accumulatedSalesResetTriggered || totalAccRounded >= ACCUMULATED_SALES_RESET_THRESHOLD;
    const accExcess = (val: number): number => {
      const cents = Math.round(val * 100);
      if (cents <= 0) return 0;
      const maxCents = Math.round(ACCUMULATED_SALES_RESET_THRESHOLD * 100) - 1;
      return (((cents - 1) % maxCents) + 1) / 100;
    };
    const prevAcc = wouldHitReset ? accExcess(rawPrevAcc) : rawPrevAcc;
    const presentAccSales = wouldHitReset ? accExcess(totalAccRounded) : totalAccRounded;
    const salesForDay = Number(grossSalesBeforeDiscount);

    out += sa('Present Acc. Sales:') + ss(_money(presentAccSales));
    out += sa('Previous Acc. Sales:') + ss(_money(prevAcc));
    out += sa('Sales for the Day') + ss(_money(salesForDay));

    out += mm('-'.repeat(30));
    out += mmBold('BREAKDOWN OF SALES');
    out += sa('VATable Sales:') + ss(_money(vatableSales));
    out += sa('VAT-Exempt Sales:') + ss(_money(vatExemptSales));
    out += sa('VAT Zero-Rated Sales:') + ss(_money(zeroRatedSales));
    out += sa('VAT Amount:') + ss(_money(vatAmount));

    out += mm('-'.repeat(30));
    out += sa('Gross Amount:') + ss(_money(Number(grossSalesBeforeDiscount) || grossSales));
    out += sa('Less Discount:') + ss(_money(lessDiscount));
    out += sa('Less Return:') + ss(_money(Math.abs(Number(lessReturn) || 0)));
    out += sa('Less Void:') + ss(_money(Math.abs(lessVoidActual || 0)));
    out += sa('Less Refund:') + ss(_money(lessRefundAmount));
    out += sa('Less VAT Adjustment:') + ss(_money(Math.abs(totalLessVatAdj)));
    out += sa('Net Amount:') + ss(_money(netSalesForDay));

    out += mm('-'.repeat(30));
    out += mmBold('DISCOUNT SUMMARY');
    out += sa('SC Discount:') + ss(_money(scDiscount));
    out += sa('PWD Discount:') + ss(_money(pwdDiscount));
    out += sa('NAAC Discount:') + ss(_money(naacDiscount));
    out += sa('Solo Parent Discount:') + ss(_money(soloParentDiscount));
    out += sa('MOV Discount:') + ss(_money(medalOfValorDiscount));
    out += sa('Regular Discount:') + ss(_money(othersDiscount));

    out += mm('-'.repeat(30));
    out += mmBold('SALES ADJUSTMENT');
    out += sa('VOID:') + ss(_money(Math.abs(lessVoidActual || 0)));
    out += sa('REFUND:') + ss(_money(lessRefundAmount));
    out += sa('RETURN:') + ss(_money(Math.abs(Number(lessReturn) || 0)));

    out += mm('-'.repeat(30));
    out += mmBold('VAT ADJUSTMENT');
    const zeroRatedReturnVatAdj = Number(returnSummary?.zeroRatedReturnVatAdj) || 0;
    const vatOnReturn = Number(returnSummary?.vatOnReturns) || 0;
    const vatOnVoid = (voidVatAdj != null ? voidVatAdj : null) ?? Math.max(0, (Number(vatOnReturns) || 0) - vatOnReturn);
    const vatOnRefund = refundVatReturns;

    out += sa('SC TRANS:') + ss(_money(Number(scVatAdj) || 0));
    out += sa('PWD TRANS:') + ss(_money(Number(pwdVatAdj) || 0));
    out += sa('SOLO PARENT TRANS:') + ss(_money(Number(soloParentVatAdj) || 0));
    out += sa('MOV TRANS:') + ss(_money(Number(medalOfValorVatAdj) || 0));
    out += sa('REG. DISC. TRANS:') + ss(_money(Number(othersTrans) || 0));
    out += sa('ZERO-RATED TRANS:') + ss(_money(Math.round((zeroRatedReturnVatAdj + (Number(zeroRatedVatAdj) || 0)) * 100) / 100));
    out += sa('VAT on Return:') + ss(_money(vatOnReturn));
    out += sa('VAT on Void:') + ss(_money(vatOnVoid));
    out += sa('VAT on Refund:') + ss(_money(vatOnRefund));

    out += mm('-'.repeat(30));
    out += sa('Service Charge:') + ss(_money(serviceCharge));

    out += mm('-'.repeat(30));
    out += mmBold('TRANSACTION SUMMARY');
    out += sa('Opening Fund:') + ss(_money(Number(cashdrawer?.startingCash ?? 0)));
    out += sa('Cash Added:') + ss(_money(cashdrawer?.addedCash ?? 0));
    out += sa('Cash Tendered:') + ss(_money(effectiveCashTendered));
    for (const payment of orderNonCashPaymentKeys(nonCashPayments, settings)) {
      if (payment === 'Gift Card') continue;
      const value = Number(nonCashPayments[payment]) || 0;
      const paymentLabel = payment.toUpperCase() === 'CHECK' ? 'CHEQUE' : payment.toUpperCase() === 'GIFT CHECK' ? 'GIFT CHECK' : payment;
      out += paymentLine(paymentLabel, value, S, sa, ss, _money);
    }
    // Unconditional, matching the X block above and PAYMENTS RECEIVED.
    const consumedGCZ = Number(nonCashPayments['Gift Card']) || 0;
    out += sa('Gift Card:') + ss(_money(consumedGCZ));
    out += sa('Excess GC:') + ss(_money(displayGiftCardOver));
    const zComputedEnding = Math.round((
      Number(cashdrawer?.startingCash || 0) +
      Number(cashdrawer?.addedCash || 0) +
      effectiveCashTendered +
      displayGiftCardOver
    ) * 100) / 100;
    out += sa('Ending Balance:') + ss(_money(zComputedEnding));
    out += '\n';
  }

  out += mm('-'.repeat(30));
  const computedEnding = cashdrawer
    ? Math.round((
        Number(cashdrawer?.startingCash || 0) +
        Number(cashdrawer?.addedCash || 0) +
        effectiveCashTendered +
        displayGiftCardOver
      ) * 100) / 100
    : 0;
  const declaredCash = typeof cashDeclaration?.actualCash === 'number' ? cashDeclaration.actualCash : null;
  const shortOver = declaredCash != null ? Math.round((declaredCash - computedEnding) * 100) / 100 : 0;
  if (declaredCash != null) out += sa('Declared:') + ss(_money(declaredCash));
  const shortOverDisplay = shortOver > 0 ? `${_money(shortOver)}+` : _money(shortOver);
  out += sa('SHORT/OVER:') + ss(shortOverDisplay);

  out += '\n'.repeat(6);

  // Kept in the destructure for signature parity with the mobile reading().
  void withdrawalSummary;

  return out;
}
