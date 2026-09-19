/**
 * Special Discounts (Discount Report) workbook data.
 *
 * Verbatim port of the device's `src/mod_temp_bir/csvs/specialDiscounts.ts`
 * (utakmobileBIR), which is the BIR-accredited source of truth. Only the
 * imports and the VAT-rate lookup differ: the device reads its rates off
 * `global.C`, the web port inlines them like every other module here.
 *
 * Returns the seven Annex sheets the device writes into its Excel template:
 *   sheet1 BIR Sales Summary Report (Annex E-1, per-day recap)
 *   sheet2 Senior Citizen (E-2)      sheet5 Solo Parent (E-5)
 *   sheet3 PWD (E-3)                 sheet6 Diplomat / zero-rated (E-6)
 *   sheet4 NAAC (E-4)                sheet7 Medal of Valor
 *
 * Each sheet's first row is its header row.
 */
import { sortBy } from 'lodash-es';
import Moment from 'moment-timezone';

import Transaction from '../../models/Transaction';
import TransactionItem from '../../models/TransactionItem';
import { getTransactionSummary } from './transaction';
import { getRefundSummary, getReturnSummary, getVoidSummary } from './refund';

const VAT_RATE = 0.12;

const MP = Transaction.MONEY_PRECISION;

type Opts = {
  snapshot: any;
  month: string;
  refundsSnapshot?: any;
  returnsSnapshot?: any;
  voidsSnapshot?: any;
};

export async function specialDiscounts({ snapshot, month, refundsSnapshot, returnsSnapshot, voidsSnapshot }: Opts) {
  const salesSummaryData: Record<string, any> = {};
  const seniorData: Record<string, any[]> = {};
  const pwdData: Record<string, any[]> = {};
  const ntlAthleteData: Record<string, any[]> = {};
  const soloParentData: Record<string, any[]> = {};
  const diplomatData: Record<string, any[]> = {};
  const medalOfValorData: Record<string, any[]> = {};

  // Item 9 (Discount Reports): a discount whose sale was later voided /
  // returned / refunded must STAY in the report, flagged with the reversal
  // status and timestamp. Keyed by the original transaction key (unix), which
  // every discount row stores as `row.date`; value maps status -> timestamp.
  const reversalRemarks: Record<string, Record<string, string>> = {};
  const addReversal = (txnKey: any, label: string, tsUnix: any) => {
    const k = String(txnKey || '').trim();
    if (!k || !label) return;
    const stamp = tsUnix ? Moment(String(tsUnix), 'X').format('MM/DD/YYYY HH:mm:ss') : '';
    const forKey = (reversalRemarks[k] = reversalRemarks[k] || {});
    // Keep the first timestamp seen for a status, but upgrade a status that was
    // recorded without one (the flag is on the original line, the timestamp on
    // the reversal clone).
    if (forKey[label] === undefined || (!forKey[label] && stamp)) forKey[label] = stamp;
  };
  const remarkFor = (txnKey: any): string =>
    Object.entries(reversalRemarks[String(txnKey)] || {})
      .map(([label, stamp]) => (stamp ? `${label} ${stamp}` : label))
      .join(', ');

  snapshot.forEach((snap: any) => {
    const key = snap.key;
    const val = snap.val();
    const $txn = new Transaction({ key, val });

    const vts = { vat: 0, vatable: 0, vatExempt: 0, zeroVat: 0 };
    const discs: Record<string, number> = {
      regular: 0,
      senior: 0,
      pwd: 0,
      ntlAthlete: 0,
      diplomat: 0,
      soloParent: 0,
      medalOfValor: 0,
      commodity: 0,
    };
    
    // We'll track pax discounts in the paxData object

    // Item 9: whether a discount EXISTS must be judged on the original,
    // pre-reversal amounts. `discs`/`vts` below net the synthetic negative
    // reversal clone against the line it reverses, so a fully voided / returned
    // / refunded discounted sale sums to exactly 0 and every `discs.X > 0` guard
    // further down used to drop the row from the report entirely. The *Gross
    // accumulators ignore the clones, so the entry still appears (flagged in
    // Remarks), while `discs`/`vts` are left netted: they feed `salesSummaryData`
    // (sheet1), whose reversals are already deducted by its Returns / Refunds /
    // Voids columns, so grossing them up there would double-count.
    const discsGross: Record<string, number> = { ...discs };
    const vtsGross = { zeroVat: 0 };
    const addDisc = (type: string, amount: number, isClone: boolean) => {
      discs[type] += amount;
      if (!isClone) discsGross[type] += amount;
    };

    let qp = 0;
    let total = 0;
    let totalPrev = 0;

    // Item 9: record the reversal status + timestamp for this transaction. The
    // status is flagged on the original line (voided / returned / refunded); the
    // timestamp lives on the negative clone appended beside it, which points
    // back at the line it reverses through `index` (Transactions/index.js:
    // 1013-1021, transactionTypes.js:134-142).
    for (const $itm of $txn.items) {
      const o = $itm?.original || {};
      if ((Number(o.quantity) || 0) < 0) continue;
      addReversal($txn.key, reversalStatusOf(o), null);
    }
    for (const $itm of $txn.items) {
      const o = $itm?.original || {};
      if ((Number(o.quantity) || 0) >= 0) continue;
      const reversed = o.index != null ? $txn.items[o.index]?.original : null;
      // Fall back on the clone's own stamp field when the reversed line carries
      // no flag: refunds stamp `refund`, voids and returns stamp `return`.
      const label = reversalStatusOf(reversed) || (o.refund != null ? 'REFUNDED' : 'RETURNED');
      addReversal($txn.key, label, o.refund ?? o.return ?? null);
    }

    for (const $itm of $txn.items) {
      if (!$itm) continue;
      const isClone = isReversalClone($itm);

      // Track each discount type separately.
      // itmDiscType defaults to 'regular' (rate=0) even when no individual discount is set,
      // so we must NOT let it shadow a genuine txnDiscType (e.g. 'ntlAthlete', 'soloParent').
      const itmSpecial = $itm.itmDiscType && $itm.itmDiscType !== 'regular' ? $itm.itmDiscType : null;
      const txnSpecial = $itm.txnDiscType && $itm.txnDiscType !== 'regular' ? $itm.txnDiscType : null;

      if (itmSpecial && discs[itmSpecial] !== undefined) {
        addDisc(itmSpecial, $itm.itmDiscount || 0, isClone);
      } else if ($itm.itmDiscount) {
        addDisc('regular', $itm.itmDiscount, isClone);
      }

      if (txnSpecial && discs[txnSpecial] !== undefined) {
        addDisc(txnSpecial, $itm.txnDiscount || 0, isClone);
      } else if ($itm.txnDiscount) {
        addDisc('regular', $itm.txnDiscount, isClone);
      }

      // PAX discount: add per-type discount from _parts to discs for sales summary (SC, PWD, NAAC, Diplomat columns)
      if ($itm.original?.paxDiscount && $itm._parts?.values) {
        for (const [, part] of Object.entries($itm._parts.values) as [string, any][]) {
          const discKey = part.discType === 'ntl' ? 'ntlAthlete' : part.discType === 'sp' ? 'soloParent' : part.discType;
          if (discs[discKey] !== undefined) {
            // Diplomat: 0% discount but VAT excluded; use vatExemption for zero-rated amount
            if (part.discType === 'diplomat') {
              addDisc(discKey, part.vatExemption || 0, isClone);
            } else if (part?.discount) {
              addDisc(discKey, part.discount, isClone);
            }
          }
        }
      }

      const qtyPrice = ($itm.quantity || 0) * ($itm.price || 0);
      qp += qtyPrice;
      total += $itm.total || 0;

      if (($txn.key as any) < month) {
        totalPrev += $itm.total || 0;
      }

      if (['vatExempt', 'zeroVat'].includes($itm.vatType)) {
        (vts as any)[$itm.vatType] += $itm.grossSales || 0;
        if (!isClone && $itm.vatType === 'zeroVat') {
          vtsGross.zeroVat += $itm.grossSales || 0;
        }
      } else {
        const vatable = (qtyPrice - ($itm.discount || 0)) / 1.12;
        vts.vatable += vatable;
        vts.vat += vatable * 0.12;
      }
    }

    const date = Moment($txn.key, 'X').format('YYYY-MM-DD');
    if (!salesSummaryData[date]) {
      salesSummaryData[date] = {
        startReceiptNo: '' as string | number,
        endReceiptNo: '' as string | number,
        startReceiptCycle: 0,
        endReceiptCycle: 0,
        total: 0,
        totalPrev: 0,
        grossSales: 0,
        // Gross sales of the day's transactions recorded against a manually
        // issued SI/OR (RR 16-2018). Same definition as csvs/salesSummary.ts
        // :299-305.
        manualSales: 0,
        vat: 0,
        vatable: 0,
        vatExempt: 0,
        zeroVat: 0,
        regular: 0,
        senior: 0,
        pwd: 0,
        ntlAthlete: 0,
        diplomat: 0,
        soloParent: 0,
        medalOfValor: 0,
        qp: 0,
        netSales: 0,
        commodity: 0,
        regularDiscountVatAdj: 0,
        regTxnsVatAdj: 0,
        zeroRatedVatAdj: 0,
        // VAT adjustments by discount type (Annex E-1 Adjustment-on-VAT sub-group)
        scVatAdj: 0,
        pwdVatAdj: 0,
        soloParentVatAdj: 0,
        medalOfValorVatAdj: 0,
        diplomatVatAdj: 0,
        // Reversal-side adjustments
        vatOnReturns: 0,
        vatOnVoid: 0,
        vatOnRefund: 0,
        // Reversal sales adjustments (deductions side)
        returns: 0,
        refunds: 0,
        voids: 0,
      };
    }

    const receiptNo = $txn.original?.receiptNo;
    const receiptCycle = $txn.original?.receiptCycle ?? 0;
    const currentStart = salesSummaryData[date].startReceiptNo;
    const currentEnd = salesSummaryData[date].endReceiptNo;
    const newStart: string | number =
      currentStart === '' || (receiptNo !== undefined && receiptNo < currentStart)
        ? (receiptNo ?? '')
        : currentStart;
    const newEnd: string | number =
      currentEnd === '' || (receiptNo !== undefined && receiptNo > currentEnd)
        ? (receiptNo ?? currentEnd)
        : currentEnd;
    Object.assign(salesSummaryData[date], {
      startReceiptNo: newStart,
      endReceiptNo: newEnd,
      startReceiptCycle: newStart === receiptNo ? receiptCycle : salesSummaryData[date].startReceiptCycle,
      endReceiptCycle: newEnd === receiptNo ? receiptCycle : salesSummaryData[date].endReceiptCycle,
      total: salesSummaryData[date].total + total,
      totalPrev: salesSummaryData[date].totalPrev + totalPrev,
      grossSales: salesSummaryData[date].grossSales + ($txn.grossSales || 0),
      manualSales:
        salesSummaryData[date].manualSales +
        (String($txn.original?.manualReference || '').trim() ? ($txn.grossSales || 0) : 0),
      vat: salesSummaryData[date].vat + vts.vat,
      vatable: salesSummaryData[date].vatable + vts.vatable,
      vatExempt: salesSummaryData[date].vatExempt + vts.vatExempt,
      zeroVat: salesSummaryData[date].zeroVat + vts.zeroVat,
      regular: salesSummaryData[date].regular + discs.regular,
      senior: salesSummaryData[date].senior + discs.senior,
      pwd: salesSummaryData[date].pwd + discs.pwd,
      ntlAthlete: salesSummaryData[date].ntlAthlete + discs.ntlAthlete,
      diplomat: salesSummaryData[date].diplomat + discs.diplomat,
      soloParent: salesSummaryData[date].soloParent + discs.soloParent,
      medalOfValor: salesSummaryData[date].medalOfValor + discs.medalOfValor,
      qp: salesSummaryData[date].qp + qp,
      netSales: salesSummaryData[date].netSales + ($txn.netSales || 0),
      commodity: salesSummaryData[date].commodity + discs.commodity, // Add commodity to sales summary
    });

    const names = $txn.original?.seniorAndPwdMetadata?.names?.split(/\n+/) || [];
    const ids = $txn.original?.seniorAndPwdMetadata?.ids?.split(/\n+/) || [];
    const tins = $txn.original?.seniorAndPwdMetadata?.tins?.split(/\n+/) || [];
    // Which discount each named person carries, one entry per name, written by
    // the Register alongside the names (pax blocks and item-level discounts).
    // Absent on older records, in which case a name is assumed to belong to
    // every discount type the transaction has, as before.
    const NON_PAX_TYPE_KEY: Record<string, string> = {
      senior: 'senior', sc: 'senior',
      pwd: 'pwd',
      ntl: 'ntlAthlete', ntlAthlete: 'ntlAthlete', naac: 'ntlAthlete',
      sp: 'soloParent', soloParent: 'soloParent',
      diplomat: 'diplomat',
      mov: 'medalOfValor', medalOfValor: 'medalOfValor',
    };
    const discTypes: string[] = ($txn.original?.seniorAndPwdMetadata?.discTypes?.split(/\n+/) || [])
      .map((t: string) => NON_PAX_TYPE_KEY[(t || '').trim()] || '');

    // PAX discount: stored on first item, not on transaction root
    const paxDiscount = (() => {
      const items = $txn.original?.items;
      if (!items) return null;
      const arr = Array.isArray(items) ? items : Object.values(items);
      const firstWithPax = arr.find((i: any) => i?.paxDiscount);
      return firstWithPax?.paxDiscount ?? null;
    })();

    // For non-PAX rows, aggregate ONLY discounted items per discount type so
    // regular/non-discounted items do not leak into discount report lines.
    const nonPaxTypeAgg: Record<string, any> = {
      senior: { vatable: 0, vat: 0, vatExempt: 0, discount: 0, netSales: 0, grossSales: 0, vatExcluded: 0, grossAfterDisc: 0 },
      pwd: { vatable: 0, vat: 0, vatExempt: 0, discount: 0, netSales: 0, grossSales: 0, vatExcluded: 0, grossAfterDisc: 0 },
      ntlAthlete: { vatable: 0, vat: 0, vatExempt: 0, discount: 0, netSales: 0, grossSales: 0, vatExcluded: 0, grossAfterDisc: 0 },
      soloParent: { vatable: 0, vat: 0, vatExempt: 0, discount: 0, netSales: 0, grossSales: 0, vatExcluded: 0, grossAfterDisc: 0 },
      diplomat: { vatable: 0, vat: 0, vatExempt: 0, discount: 0, netSales: 0, grossSales: 0, vatExcluded: 0, grossAfterDisc: 0 },
      medalOfValor: { vatable: 0, vat: 0, vatExempt: 0, discount: 0, netSales: 0, grossSales: 0, vatExcluded: 0, grossAfterDisc: 0 },
    };

    // Calculate total service fee for transaction to allocate proportionally
    let totalGrossAfterDisc = 0;
    for (const $itm of $txn.items) {
      // Reversal clones are excluded so the service-fee allocation base matches
      // the original sale (they would otherwise cancel it out to 0).
      if (!$itm || isReversalClone($itm)) continue;
      const qtyPrice = ($itm.quantity || 0) * ($itm.price || 0);
      const lineGross = $itm.vatType === 'vatable' ? qtyPrice / (1 + VAT_RATE) : qtyPrice;
      const discAmt = ($itm.itmDiscount || 0) + ($itm.txnDiscount || 0);
      totalGrossAfterDisc += lineGross - discAmt;
    }
    const svcRate = ($txn.original?.service || $txn.svcRate || 0) / (typeof ($txn.original?.service) === 'number' && ($txn.original?.service) > 1 ? 100 : 1);
    const totalServiceFee = totalGrossAfterDisc * svcRate;

    for (const $itm of $txn.items) {
      // Reversal clones carry the original line's discount type with a negative
      // amount; aggregating them would cancel the entry out of the report.
      if (!$itm || isReversalClone($itm)) continue;

      const itmSpecial = $itm.itmDiscType && $itm.itmDiscType !== 'regular' ? $itm.itmDiscType : null;
      const txnSpecial = $itm.txnDiscType && $itm.txnDiscType !== 'regular' ? $itm.txnDiscType : null;
      const perItemTypeDiscount: Record<string, number> = {};

      if (itmSpecial) {
        perItemTypeDiscount[itmSpecial] = (perItemTypeDiscount[itmSpecial] || 0) + ($itm.itmDiscount || 0);
      }
      if (txnSpecial) {
        perItemTypeDiscount[txnSpecial] = (perItemTypeDiscount[txnSpecial] || 0) + ($itm.txnDiscount || 0);
      }

      for (const [discType, discAmtRaw] of Object.entries(perItemTypeDiscount)) {
        if (!nonPaxTypeAgg[discType]) continue;

        const discAmt = discAmtRaw || 0;
        // Ensure lineGross is always VAT-exclusive base (not VAT-inclusive price)
        const qtyPrice = ($itm.quantity || 0) * ($itm.price || 0);
        const lineGross = $itm.vatType === 'vatable' ? qtyPrice / (1 + VAT_RATE) : qtyPrice;
        const lineGrossAfterDisc = lineGross - discAmt;
        // Allocate service fee proportionally based on post-discount gross
        const allocatedServiceFee = totalGrossAfterDisc > 0 ? (lineGrossAfterDisc / totalGrossAfterDisc) * totalServiceFee : 0;
        // Net Sales = Gross - Discount + Allocated Service Fee
        const lineNet = lineGrossAfterDisc + allocatedServiceFee;

        if (discType !== 'diplomat' && discAmt <= 0) continue;
        if (discType === 'diplomat' && lineGross <= 0 && discAmt <= 0) continue;

        const agg = nonPaxTypeAgg[discType];
        agg.discount += discAmt;
        agg.netSales += lineNet;
        agg.grossSales += lineGross;
        agg.grossAfterDisc += lineGrossAfterDisc;

        if ($itm.vatType === 'vatExempt') {
          // Store VAT-exclusive base (89.29 for a ₱100 SC/PWD item) to match PAX flow semantics.
          // lineGross for non-vatable items is VAT-inclusive qtyPrice, so divide back to base.
          const vatRate = VAT_RATE;
          agg.vatExempt += lineGross / (1 + vatRate);
        } else if ($itm.vatType === 'zeroVat' || discType === 'diplomat') {
          const vatExcluded = $itm.vatExemption || ($itm.vatType === 'zeroVat' ? (lineGross / 1.12) * 0.12 : 0);
          agg.vatExcluded += vatExcluded;
        } else {
          const vatable = (lineGross - discAmt) / 1.12;
          agg.vatable += vatable;
          agg.vat += vatable * 0.12;
        }
      }
    }

    if (paxDiscount) {
      // PAX: use _parts from items (matches printed receipt) - aggregate per type
      type PartAgg = { grossSales: number; discount: number; netSales: number; vatable: number; vat: number; vatExempt: number; vatExemption: number };
      const typeAgg: Record<string, PartAgg> = {};

      for (const $itm of $txn.items) {
        // Skip reversal clones: their negative parts cancelled the original PAX
        // amounts out to 0, which dropped the whole block from the report.
        if (!$itm?._parts?.values || isReversalClone($itm)) continue;
        for (const [partDiscType, part] of Object.entries($itm._parts.values) as [string, any][]) {
          if (!['senior', 'pwd', 'ntl', 'sp', 'diplomat', 'medalOfValor'].includes(partDiscType)) continue;
          if (!typeAgg[partDiscType]) {
            typeAgg[partDiscType] = { grossSales: 0, discount: 0, netSales: 0, vatable: 0, vat: 0, vatExempt: 0, vatExemption: 0 };
          }
          typeAgg[partDiscType].grossSales += part.grossSales || 0;
          typeAgg[partDiscType].discount += part.discount || 0;
          typeAgg[partDiscType].netSales += part.netSales || 0;
          typeAgg[partDiscType].vatExemption += part.vatExemption || 0;
          if (part.vatType === 'vatable') {
            typeAgg[partDiscType].vatable += part.discType === 'ntl' ? (part.grossSales || 0) : (part.netSales || 0);
            typeAgg[partDiscType].vat += part.vat || 0;
          } else if (part.vatType === 'vatExempt') {
            typeAgg[partDiscType].vatExempt += part.grossSales || 0;
          }
        }
      }

      for (const [discType, discObj] of Object.entries(paxDiscount)) {
        const typedDiscObj = discObj as any;
        // Diplomat has percent 0; allow when guestCount exists
        if (!typedDiscObj.guestCount) continue;
        if (discType !== 'diplomat' && !typedDiscObj.percent) continue;

        const agg = typeAgg[discType];
        if (!agg) continue;
        // Diplomat: include when grossSales > 0 (VAT-exclusive); others: discount or grossSales
        if (discType === 'diplomat') {
          if (agg.grossSales <= 0 && agg.netSales <= 0) continue;
        } else if (agg.discount <= 0 && agg.grossSales <= 0) {
          continue;
        }

        const blockNames = (typedDiscObj.names || '').split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
        const blockIds = (typedDiscObj.ids || '').split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
        const blockTins = (typedDiscObj.tins || '').split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
        const blockChildNames = discType === 'sp' ? (typedDiscObj.childNames || typedDiscObj.childName || '').split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean) : [] as string[];
        const blockChildBirthDates = discType === 'sp' ? (typedDiscObj.childBirthDates || typedDiscObj.childBirthDate || '').split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean) : [] as string[];
        const blockChildAges = discType === 'sp' ? (typedDiscObj.childAges || (typedDiscObj.childAge != null ? String(typedDiscObj.childAge) : '')).split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean) : [] as string[];
        const guestCountForType = parseInt(typedDiscObj.guestCount, 10) || 1;
        const n = discType === 'sp'
          ? Math.max(blockNames.length, blockIds.length, blockTins.length, blockChildNames.length, guestCountForType) || 1
          : Math.max(blockNames.length, blockIds.length, blockTins.length, guestCountForType) || 1;

        // Per-person portion: gross/discount/net from _parts (matches receipt), divided by n
        const grossPerRow = agg.grossSales / n;
        const discountPerRow = agg.discount / n;
        const netPerRow = agg.netSales / n;
        const vatablePerRow = agg.vatable / n;
        const vatPerRow = agg.vat / n;
        const vatExemptPerRow = agg.vatExempt / n;

        const typeLabels: Record<string, string> = {
          senior: 'Senior Citizen (No ID)',
          pwd: 'PWD (No ID)',
          ntl: 'NAAC (No ID)',
          sp: 'Solo Parent (No ID)',
          diplomat: 'Diplomat (No ID)',
          medalOfValor: 'Medal of Valor (No ID)',
        };
        const defaultLabel = typeLabels[discType] || 'Guest';

        for (let i = 0; i < n; i++) {
          const name = blockNames[i] || blockIds[i] || (n > 1 ? `${defaultLabel} ${i + 1}` : defaultLabel);

          if (discType === 'senior') {
            if (!seniorData[name]) seniorData[name] = [];
            seniorData[name].push({
              id: blockIds[i] || '',
              tin: blockTins[i] || '',
              date: $txn.key,
              receiptCycle: $txn.original?.receiptCycle ?? 0,
              receiptNo: $txn.original?.receiptNo || '',
              vatable: vatablePerRow,
              vat: vatPerRow,
              vatExempt: vatExemptPerRow,
              discount: discountPerRow,
              netSales: netPerRow,
            });
          } else if (discType === 'pwd') {
            if (!pwdData[name]) pwdData[name] = [];
            pwdData[name].push({
              id: blockIds[i] || '',
              tin: blockTins[i] || '',
              date: $txn.key,
              receiptCycle: $txn.original?.receiptCycle ?? 0,
              receiptNo: $txn.original?.receiptNo || '',
              vatable: vatablePerRow,
              vat: vatPerRow,
              vatExempt: vatExemptPerRow,
              discount: discountPerRow,
              netSales: netPerRow,
            });
          } else if (discType === 'medalOfValor') {
            if (!medalOfValorData[name]) medalOfValorData[name] = [];
            medalOfValorData[name].push({
              id: blockIds[i] || '',
              tin: blockTins[i] || '',
              date: $txn.key,
              receiptCycle: $txn.original?.receiptCycle ?? 0,
              receiptNo: $txn.original?.receiptNo || '',
              vatable: vatablePerRow,
              vat: vatPerRow,
              vatExempt: vatExemptPerRow,
              discount: discountPerRow,
              netSales: netPerRow,
            });
          } else if (discType === 'ntl') {
            if (!ntlAthleteData[name]) ntlAthleteData[name] = [];
            // NAAC is VATable — Annex E-4 Gross Sales/Receipts is VAT-inclusive;
            // Net = inclusive gross − discount.
            const vr = VAT_RATE;
            const naacGrossInclusive = grossPerRow * (1 + vr);
            const naacNetSales = TransactionItem.round(naacGrossInclusive - discountPerRow);
            ntlAthleteData[name].push({
              id: blockIds[i] || '',
              date: $txn.key,
              receiptCycle: $txn.original?.receiptCycle ?? 0,
              receiptNo: $txn.original?.receiptNo || '',
              discount: discountPerRow,
              grossSales: naacGrossInclusive,
              netSales: naacNetSales,
            });
          } else if (discType === 'sp') {
            if (!soloParentData[name]) soloParentData[name] = [];
            const soloMeta = $txn.original?.soloParentMetadata || $txn.original?.soloParentDetails;
            const childName = blockChildNames[i] || typedDiscObj.childName || soloMeta?.childName || '';
            const childBirthDate = blockChildBirthDates[i] || typedDiscObj.childBirthDate || soloMeta?.childBirthDate || '';
            const childAge = blockChildAges[i] != null && blockChildAges[i] !== '' ? blockChildAges[i] : (typedDiscObj.childAge ?? soloMeta?.childAge ?? '');
            const soloBaseAfterDiscount = grossPerRow - discountPerRow;
            const soloServiceFee = soloBaseAfterDiscount * svcRate;
            const soloNetSales = TransactionItem.round(soloBaseAfterDiscount + soloServiceFee);
            soloParentData[name].push({
              id: blockIds[i] || '',
              date: $txn.key,
              receiptCycle: $txn.original?.receiptCycle ?? 0,
              receiptNo: $txn.original?.receiptNo || '',
              discount: discountPerRow,
              grossSales: grossPerRow,
              netSales: soloNetSales,
              childName,
              childBirthDate,
              childAge,
            });
          } else if (discType === 'diplomat') {
            if (!diplomatData[name]) diplomatData[name] = [];
            // Annex E-6 columns: Gross is VAT-inclusive, Net is VAT-exclusive.
            const vr = VAT_RATE;
            const diploGrossInclusive = grossPerRow * (1 + vr);
            const vatExemptPerRow = (agg.vatExemption || 0) / n;
            diplomatData[name].push({
              id: blockIds[i] || '',
              tin: blockTins[i] || '',
              date: $txn.key,
              receiptCycle: $txn.original?.receiptCycle ?? 0,
              receiptNo: $txn.original?.receiptNo || '',
              grossSales: diploGrossInclusive,
              vatExcluded: vatExemptPerRow,
              netSales: grossPerRow,
            });
          }
        }
      }
    } else {
      // Non-PAX: use seniorAndPwdMetadata names for discounts (both item-level and transaction-level)
      // Check discount amounts directly (discs.X > 0) since discounts can be at item or transaction level
      // A named person prints under their own discount type only. A name with
      // no recorded type (older records) prints under every type present, as
      // it always did.
      const rowIsType = (n: number, type: string) => !discTypes[n] || discTypes[n] === type;
      // One transaction's figures for a type are shared out over the people
      // who print under it, so two named seniors on one sale carry half each
      // and the sheet total still equals the sale — same rule as the pax rows.
      const rowsUnder = (type: string) =>
        names.filter((nm: string, i: number) => nm && rowIsType(i, type)).length || 1;
      const aggFor = (type: string) => {
        const src = nonPaxTypeAgg[type];
        const share = rowsUnder(type);
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(src)) out[k] = (v as number) / share;
        return out;
      };

      for (let n = 0; n < names.length; n++) {
        const name = names[n];
        if (!name) continue;

        // Senior discount - check actual discount amount instead of txnDiscType
        if (discsGross.senior > 0 && rowIsType(n, 'senior')) {
          const agg = aggFor('senior');
          if (agg.discount <= 0) continue;
          if (!seniorData[name]) seniorData[name] = [];
          seniorData[name].push({
            id: ids[n] || '',
            tin: tins[n] || '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            vatable: agg.vatable,
            vat: agg.vat,
            vatExempt: agg.vatExempt,
            discount: agg.discount,
            // Net = VAT-exempt base − discount. Excludes VAT (already removed) and service charge.
            netSales: agg.vatExempt - agg.discount,
          });
        }

        // PWD discount
        if (discsGross.pwd > 0 && rowIsType(n, 'pwd')) {
          const agg = aggFor('pwd');
          if (agg.discount <= 0) continue;
          if (!pwdData[name]) pwdData[name] = [];
          pwdData[name].push({
            id: ids[n] || '',
            tin: tins[n] || '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            vatable: agg.vatable,
            vat: agg.vat,
            vatExempt: agg.vatExempt,
            discount: agg.discount,
            netSales: agg.vatExempt - agg.discount,
          });
        }

        // Medal of Valor discount
        if (discsGross.medalOfValor > 0 && rowIsType(n, 'medalOfValor')) {
          const agg = aggFor('medalOfValor');
          if (agg.discount <= 0) continue;
          if (!medalOfValorData[name]) medalOfValorData[name] = [];
          medalOfValorData[name].push({
            id: ids[n] || '',
            tin: tins[n] || '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            vatable: agg.vatable,
            vat: agg.vat,
            vatExempt: agg.vatExempt,
            discount: agg.discount,
            netSales: agg.vatExempt - agg.discount,
          });
        }

        // NAAC discount — VATable, keeps VAT in net
        if (discsGross.ntlAthlete > 0 && rowIsType(n, 'ntlAthlete')) {
          const agg = aggFor('ntlAthlete');
          if (agg.discount <= 0) continue;
          if (!ntlAthleteData[name]) ntlAthleteData[name] = [];
          const vr = VAT_RATE;
          // Gross Sales per Annex E-4 is VAT-inclusive. Net = inclusive gross − discount.
          const ntlGrossInclusive = (agg.grossSales || 0) * (1 + vr);
          const ntlNetSales = ntlGrossInclusive - agg.discount;
          ntlAthleteData[name].push({
            id: ids[n] || '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            discount: agg.discount,
            grossSales: ntlGrossInclusive,
            netSales: ntlNetSales,
          });
        }

        // Solo Parent discount — VAT-exempt 10%
        if (discsGross.soloParent > 0 && rowIsType(n, 'soloParent')) {
          const agg = aggFor('soloParent');
          if (agg.discount <= 0) continue;
          if (!soloParentData[name]) soloParentData[name] = [];
          const soloMeta = $txn.original?.soloParentMetadata || $txn.original?.soloParentDetails;
          const soloBaseAfterDiscount = agg.vatExempt - agg.discount;
          const soloServiceFee = soloBaseAfterDiscount * svcRate;
          soloParentData[name].push({
            id: ids[n] || '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            discount: agg.discount,
            grossSales: agg.vatExempt,
            netSales: soloBaseAfterDiscount + soloServiceFee,
            childName: soloMeta?.childName || '',
            childBirthDate: soloMeta?.childBirthDate || '',
            childAge: soloMeta?.childAge ?? '',
          });
        }

        // Diplomat discount (zero-rated)
        if ((discsGross.diplomat > 0 || vtsGross.zeroVat > 0) && rowIsType(n, 'diplomat')) {
          const agg = aggFor('diplomat');
          if (agg.grossSales <= 0 && agg.vatExcluded <= 0) continue;
          if (!diplomatData[name]) diplomatData[name] = [];
          diplomatData[name].push({
            id: ids[n] || '',
            tin: tins[n] || '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            grossSales: agg.grossSales,
            vatExcluded: agg.vatExcluded || 0,
            // Net = VAT-inclusive gross − VAT excluded (the zero-rated base).
            netSales: (agg.grossSales || 0) - (agg.vatExcluded || 0),
          });
        }
      }
      // Non-PAX mandated discounts with no names/IDs: add single row with fallback name
      // Check discount amounts directly (discs.X > 0) since discounts can be at item or transaction level
      if (names.length === 0) {
        // Senior discount - check if any discount amount exists
        if (discsGross.senior > 0) {
          const agg = nonPaxTypeAgg.senior;
          if (agg.discount <= 0) {
            // no discounted item for this type in this transaction
          } else {
          const fallbackName = 'Senior Citizen (No ID)';
          if (!seniorData[fallbackName]) seniorData[fallbackName] = [];
          seniorData[fallbackName].push({
            id: '',
            tin: '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            vatable: agg.vatable,
            vat: agg.vat,
            vatExempt: agg.vatExempt,
            discount: agg.discount,
            netSales: agg.vatExempt - agg.discount,
          });
          }
        }

        // PWD discount
        if (discsGross.pwd > 0) {
          const agg = nonPaxTypeAgg.pwd;
          if (agg.discount <= 0) {
            // no discounted item for this type in this transaction
          } else {
          const fallbackName = 'PWD (No ID)';
          if (!pwdData[fallbackName]) pwdData[fallbackName] = [];
          pwdData[fallbackName].push({
            id: '',
            tin: '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            vatable: agg.vatable,
            vat: agg.vat,
            vatExempt: agg.vatExempt,
            discount: agg.discount,
            netSales: agg.vatExempt - agg.discount,
          });
          }
        }

        // Medal of Valor discount
        if (discsGross.medalOfValor > 0) {
          const agg = nonPaxTypeAgg.medalOfValor;
          if (agg.discount <= 0) {
            // no discounted item for this type in this transaction
          } else {
          const fallbackName = 'Medal of Valor (No ID)';
          if (!medalOfValorData[fallbackName]) medalOfValorData[fallbackName] = [];
          medalOfValorData[fallbackName].push({
            id: '',
            tin: '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            vatable: agg.vatable,
            vat: agg.vat,
            vatExempt: agg.vatExempt,
            discount: agg.discount,
            netSales: agg.vatExempt - agg.discount,
          });
          }
        }

        // NAAC discount — VATable, keeps VAT in net
        if (discsGross.ntlAthlete > 0) {
          const agg = nonPaxTypeAgg.ntlAthlete;
          if (agg.discount <= 0) {
            // no discounted item for this type in this transaction
          } else {
          const fallbackName = 'NAAC (No ID)';
          if (!ntlAthleteData[fallbackName]) ntlAthleteData[fallbackName] = [];
          const vr = VAT_RATE;
          const ntlGrossInclusive = (agg.grossSales || 0) * (1 + vr);
          const ntlNetSales = ntlGrossInclusive - agg.discount;
          ntlAthleteData[fallbackName].push({
            id: '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            discount: agg.discount,
            grossSales: ntlGrossInclusive,
            netSales: ntlNetSales,
          });
          }
        }

        // Solo Parent discount — VAT-exempt 10%
        if (discsGross.soloParent > 0) {
          const agg = nonPaxTypeAgg.soloParent;
          if (agg.discount <= 0) {
            // no discounted item for this type in this transaction
          } else {
          const fallbackName = 'Solo Parent (No ID)';
          if (!soloParentData[fallbackName]) soloParentData[fallbackName] = [];
          const soloMeta = $txn.original?.soloParentMetadata || $txn.original?.soloParentDetails;
          const soloBaseAfterDiscount = agg.vatExempt - agg.discount;
          const soloServiceFee = soloBaseAfterDiscount * svcRate;
          soloParentData[fallbackName].push({
            id: '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            discount: agg.discount,
            grossSales: agg.vatExempt,
            netSales: soloBaseAfterDiscount + soloServiceFee,
            childName: soloMeta?.childName || '',
            childBirthDate: soloMeta?.childBirthDate || '',
            childAge: soloMeta?.childAge ?? '',
          });
          }
        }

        // Diplomat discount (zero-rated)
        if (discsGross.diplomat > 0 || vtsGross.zeroVat > 0) {
          const agg = nonPaxTypeAgg.diplomat;
          if (agg.grossSales <= 0 && agg.vatExcluded <= 0) {
            // no discounted item for this type in this transaction
          } else {
          const fallbackName = 'Diplomat (No ID)';
          if (!diplomatData[fallbackName]) diplomatData[fallbackName] = [];
          diplomatData[fallbackName].push({
            id: '',
            tin: '',
            date: $txn.key,
            receiptCycle: $txn.original?.receiptCycle ?? 0,
            receiptNo: $txn.original?.receiptNo || '',
            grossSales: agg.grossSales,
            vatExcluded: agg.vatExcluded || 0,
            netSales: (agg.grossSales || 0) - (agg.vatExcluded || 0),
          });
          }
        }
      }
    }
  });

  // Calculate VAT adjustments from transaction summary
  const txnSummary = getTransactionSummary(snapshot);
  for (const txn of txnSummary) {
    const date = txn.date;
    if (!salesSummaryData[date]) continue;
    const aov = (txn.adjustmentOnVat?.discount as any) || {};
    salesSummaryData[date].regularDiscountVatAdj =
      (salesSummaryData[date].regularDiscountVatAdj || 0) + (aov.others || 0);
    salesSummaryData[date].regTxnsVatAdj =
      (salesSummaryData[date].regTxnsVatAdj || 0) + (aov.regTxns || 0);
    salesSummaryData[date].scVatAdj =
      (salesSummaryData[date].scVatAdj || 0) + (aov.sc || 0);
    salesSummaryData[date].pwdVatAdj =
      (salesSummaryData[date].pwdVatAdj || 0) + (aov.pwd || 0);
    salesSummaryData[date].soloParentVatAdj =
      (salesSummaryData[date].soloParentVatAdj || 0) + (aov.soloParent || 0);
    salesSummaryData[date].medalOfValorVatAdj =
      (salesSummaryData[date].medalOfValorVatAdj || 0) + (aov.medalOfValor || 0);
    salesSummaryData[date].vatOnReturns =
      (salesSummaryData[date].vatOnReturns || 0) + (txn.adjustmentOnVat?.returns || 0);
    // Diplomat VAT excluded — Zero-rated VAT base × VAT rate, surfaced per-day from zero-rated sales.
    const vr = VAT_RATE;
    salesSummaryData[date].diplomatVatAdj =
      (salesSummaryData[date].diplomatVatAdj || 0) + ((txn.zeroRatedSales || 0) * vr);
    salesSummaryData[date].zeroRatedVatAdj = salesSummaryData[date].diplomatVatAdj;
  }

  // Aggregate refunds per day: sales adjustment + VAT on refund
  if (refundsSnapshot && (refundsSnapshot as any).exists?.()) {
    const refundSum = getRefundSummary(refundsSnapshot);
    for (const r of refundSum || []) {
      const rDate = (r as any).date;
      if (!rDate || !salesSummaryData[rDate]) continue;
      const salesAdj =
        Math.abs((r as any).vatableSales || 0) +
        Math.abs((r as any).vatExemptSales || 0) +
        Math.abs((r as any).zeroRatedSales || 0);
      salesSummaryData[rDate].refunds =
        (salesSummaryData[rDate].refunds || 0) + salesAdj;
      salesSummaryData[rDate].vatOnRefund =
        (salesSummaryData[rDate].vatOnRefund || 0) + Math.abs((r as any).vatAmount || 0);
    }
  }

  // Aggregate voids per day: sales adjustment + VAT on void
  if (voidsSnapshot && (voidsSnapshot as any).exists?.()) {
    const voidSum = getVoidSummary(voidsSnapshot);
    for (const v of voidSum?.voids || []) {
      const vKey = (v as any).key;
      const ts = parseInt(String(vKey), 10);
      if (!ts) continue;
      const vDate = Moment.unix(ts).format('YYYY-MM-DD');
      if (!salesSummaryData[vDate]) continue;
      salesSummaryData[vDate].voids =
        (salesSummaryData[vDate].voids || 0) + Math.abs(Number((v as any).voidBase) || 0);
      salesSummaryData[vDate].vatOnVoid =
        (salesSummaryData[vDate].vatOnVoid || 0) + Math.abs(Number((v as any).voidVat) || 0);
    }
  }

  // Aggregate returns per day: sales adjustment + VAT on returns (overrides txn-level vatOnReturns with Z-aligned value)
  if (returnsSnapshot && (returnsSnapshot as any).exists?.()) {
    const returnSum = getReturnSummary(returnsSnapshot);
    const perDateReturnsDed: Record<string, number> = {};
    const perDateVatOnReturns: Record<string, number> = {};
    for (const r of returnSum?.returns || []) {
      const rKey = (r as any).key;
      const ts = parseInt(String(rKey), 10);
      if (!ts) continue;
      const rDate = Moment.unix(ts).format('YYYY-MM-DD');
      const returnsSalesAdj =
        Math.abs(Number((r as any).vatableSales) || 0) +
        Math.abs(Number((r as any).vatExemptSales) || 0) +
        Math.abs(Number((r as any).zeroRatedSales) || 0);
      perDateReturnsDed[rDate] =
        (perDateReturnsDed[rDate] || 0) + returnsSalesAdj;
      perDateVatOnReturns[rDate] =
        (perDateVatOnReturns[rDate] || 0) + Math.abs(Number((r as any).vatAmount) || 0);
    }
    for (const date in perDateReturnsDed) {
      if (salesSummaryData[date]) {
        salesSummaryData[date].returns = perDateReturnsDed[date];
      }
    }
    for (const date in perDateVatOnReturns) {
      if (salesSummaryData[date]) {
        salesSummaryData[date].vatOnReturns = perDateVatOnReturns[date];
      }
    }
  }

  // Secondary source for the Remarks column: the reversal collections. The
  // transaction's own items (handled above) are authoritative and cover the
  // refund case, which nothing else can — a refunds/ record is a copy of the
  // transaction with NO back-pointer to it (transactionTypes.js:184), so
  // `transactionKey` is usually absent. `addReversal` de-duplicates per status,
  // so a reversal found in both places is reported once.
  (refundsSnapshot as any)?.forEach?.((snap: any) => {
    const v = snap.val() || {};
    addReversal(v.transactionKey || v.originalTransactionKey, 'REFUNDED', snap.key);
  });
  (returnsSnapshot as any)?.forEach?.((snap: any) => {
    const v = snap.val() || {};
    addReversal(v.originalTransactionKey || v.transactionKey, 'RETURNED', snap.key);
  });
  (voidsSnapshot as any)?.forEach?.((snap: any) => {
    const v = snap.val() || {};
    if (v.isCancel) return;
    addReversal(v.originalTransactionKey || v.transactionKey, 'VOIDED', snap.key);
  });

  // Senior Citizens sheet
  // BIR template columns for VAT-exempt SC sales.
  // SC items are VAT-exempt: VAT Amount = 0, but we still show the would-have-been
  // VAT-inclusive gross (`vatExempt × 1.12`) so the report ties back to the SI total.
  const sheet2: any[] = [
  [
    'Date',
    'Name of Senior Citizen (SC)',
    'OSCA ID No./SC ID No.',
    'SC TIN',
    'SI Number',
    'Sales (inclusive of VAT)',
    'VAT Amount',
    'VAT Exempt Sales',
    'Discount (5%)',
    'Discount (20%)',
    'Net Sales',
    'Remarks',
  ],
];

  for (const name in seniorData) {
    const sortedData = sortBy(seniorData[name], ['date', 'transactionNo', 'receiptCycle', 'receiptNo']);
    for (const row of sortedData) {
      const vatExempt = row.vatExempt || 0;
      // VAT-inclusive gross = exempt base × (1 + VAT rate). For SC items vatExempt is
      // the VAT-exclusive base (e.g. 89.29 for a ₱100 item).
      const salesInclVat = vatExempt * (1 + VAT_RATE);
      // SC is VAT-exempt — no VAT was actually charged to the customer.
      const vatAmount = 0;
      sheet2.push([
        normalize(Moment(row.date, 'X').format('MM/DD/YYYY')),
        normalize(name),
        normalize(row.id),
        normalize(row.tin?.length > 0 ? row.tin : 'N/A'),
        normalize(formatReceiptNo(row.receiptCycle ?? 0, row.receiptNo ?? '')),
        normalize(TransactionItem.round(salesInclVat) / MP),
        normalize(TransactionItem.round(vatAmount) / MP),
        normalize(TransactionItem.round(vatExempt) / MP),
        normalize(0), // Discount (5%) — reserved column, rarely used
        normalize(TransactionItem.round(row.discount) / MP),
        normalize(TransactionItem.round(row.netSales) / MP),
        // Remarks kept raw (XLSX output) so the reversal timestamp's colons/commas
        // survive — normalize() would strip them.
        remarkFor(row.date),
      ]);
    }
  }

  // Persons with Disability sheet — same structure as SC (also VAT-exempt)
  const sheet3: any[] = [
  [
    'Date',
    'Name of Person with Disability (PWD)',
    'PWD ID No.',
    'PWD TIN',
    'SI Number',
    'Sales (inclusive of VAT)',
    'VAT Amount',
    'VAT Exempt Sales',
    'Discount (5%)',
    'Discount (20%)',
    'Net Sales',
    'Remarks',
  ],
];
  for (const name in pwdData) {
    const sortedData = sortBy(pwdData[name], ['date', 'transactionNo', 'receiptCycle', 'receiptNo']);
    for (const row of sortedData) {
      const vatExempt = row.vatExempt || 0;
      const salesInclVat = vatExempt * (1 + VAT_RATE);
      const vatAmount = 0;
      sheet3.push([
        normalize(Moment(row.date, 'X').format('MM/DD/YYYY')),
        normalize(name),
        normalize(row.id),
        normalize(row.tin?.length > 0 ? row.tin : 'N/A'),
        normalize(formatReceiptNo(row.receiptCycle ?? 0, row.receiptNo ?? '')),
        normalize(TransactionItem.round(salesInclVat) / MP),
        normalize(TransactionItem.round(vatAmount) / MP),
        normalize(TransactionItem.round(vatExempt) / MP),
        normalize(0), // Discount (5%) — reserved column, rarely used
        normalize(TransactionItem.round(row.discount) / MP),
        normalize(TransactionItem.round(row.netSales) / MP),
        remarkFor(row.date),
      ]);
    }
  }

  // National Athletes sheet (Annex E-4)
const sheet4: any[] = [
  [
    'Date',
    'Name of National Athlete/Coach',
    'PNSTM ID No.',
    'SI Number',
    'Gross Sales/Receipts',
    'Sales Discount',
    'Net Sales',
    'Remarks',
  ],
];

for (const name in ntlAthleteData) {
  const sortedData = sortBy(ntlAthleteData[name], ['date', 'transactionNo', 'receiptCycle', 'receiptNo']);
  for (const row of sortedData) {
    const grossSales = row.grossSales || 0;
    const netSales = row.netSales != null ? row.netSales : (grossSales - (row.discount || 0));
    sheet4.push([
      normalize(Moment(row.date, 'X').format('MM/DD/YYYY')), // Date
      normalize(name), // Name of National Athlete/Coach
      normalize(row.id), // PNSTM ID No.
      normalize(formatReceiptNo(row.receiptCycle ?? 0, row.receiptNo ?? '')), // SI Number
      normalize(TransactionItem.round(grossSales) / MP), // Gross Sales/Receipts
      normalize(TransactionItem.round(row.discount) / MP), // Sales Discount
      normalize(TransactionItem.round(netSales) / MP), // Net Sales
      remarkFor(row.date), // Remarks
    ]);
  }
}

// Solo Parent sheet (Annex E-5)
const sheet5: any[] = [
  [
    'Date',
    'Name of Solo Parent',
    'SPIC No.',
    'Name of child',
    'Birth Date of child',
    'Age of child',
    'SI Number',
    'Gross Sales',
    'Discount (5%)',
    'Discount (20%)',
    'Net Sales',
    'Remarks',
  ],
];

for (const name in soloParentData) {
  const sortedData = sortBy(soloParentData[name], ['date', 'transactionNo', 'receiptCycle', 'receiptNo']);
  for (const row of sortedData) {
    const grossSales = row.grossSales || 0;
    const netSales = row.netSales != null ? row.netSales : (grossSales - (row.discount || 0));
    sheet5.push([
      normalize(Moment(row.date, 'X').format('MM/DD/YYYY')), // Date
      normalize(name), // Name of Solo Parent
      normalize(row.id), // SPIC No.
      normalize(row.childName || ''), // Name of child
      normalize(row.childBirthDate ? Moment(row.childBirthDate).format('MM/DD/YYYY') : ''), // Birth Date of child
      normalize(row.childAge?.toString() || ''), // Age of child
      normalize(formatReceiptNo(row.receiptCycle ?? 0, row.receiptNo ?? '')), // SI Number
      normalize(TransactionItem.round(grossSales) / MP), // Gross Sales
      normalize(0), // Discount (5%) — reserved column, rarely used
      normalize(TransactionItem.round(row.discount) / MP), // Discount (20%)
      normalize(TransactionItem.round(netSales) / MP), // Net Sales
      remarkFor(row.date), // Remarks
    ]);
  }
}

  // Diplomat (Zero-Rated) sheet
  // Diplomat sales are zero-rated: the VAT is excluded from the sale.
  // - Gross Sales (VAT-inclusive): grossSales (original SI amount, e.g. ₱100)
  // - VAT Excluded (Zero-Rated): vatExcluded (the VAT amount that was excluded, e.g. ₱10.71)
  // - Net Sales (VAT-exclusive): netSales (gross − VAT excluded, e.g. ₱89.29)
  const sheet6: any[] = [
    [
      'Date',
      'Name of Diplomat',
      'Diplomatic ID No.',
      'TIN',
      'SI Number',
      'Gross Sales (VAT-inclusive)',
      'VAT Excluded (Zero-Rated)',
      'Net Sales (VAT-exclusive)',
      'Remarks',
    ],
  ];

  for (const name in diplomatData) {
    const sortedData = sortBy(diplomatData[name], ['date', 'transactionNo', 'receiptCycle', 'receiptNo']);
    for (const row of sortedData) {
      const grossSales = row.grossSales || 0;
      const vatExcluded = row.vatExcluded || 0;
      // Net = gross − VAT excluded (or use stored netSales when available)
      const netSales = row.netSales != null ? row.netSales : (grossSales - vatExcluded);
      sheet6.push([
        normalize(Moment(row.date, 'X').format('MM/DD/YYYY')),
        normalize(name),
        normalize(row.id || ''),
        normalize(row.tin?.length > 0 ? row.tin : 'N/A'),
        normalize(formatReceiptNo(row.receiptCycle ?? 0, row.receiptNo ?? '')),
        normalize(TransactionItem.round(grossSales) / MP),
        normalize(TransactionItem.round(vatExcluded) / MP),
        normalize(TransactionItem.round(netSales) / MP),
        remarkFor(row.date),
      ]);
    }
  }

  // Medal of Valor sheet — same structure as SC/PWD (also VAT-exempt, 20% discount)
  const sheet7: any[] = [
    [
      'Date',
      'Name of Medal of Valor Recipient',
      'Medal of Valor ID No.',
      'TIN',
      'SI Number',
      'Sales (inclusive of VAT)',
      'VAT Amount',
      'VAT Exempt Sales',
      'Discount (5%)',
      'Discount (20%)',
      'Net Sales',
      'Remarks',
    ],
  ];
  for (const name in medalOfValorData) {
    const sortedData = sortBy(medalOfValorData[name], ['date', 'transactionNo', 'receiptCycle', 'receiptNo']);
    for (const row of sortedData) {
      const vatExempt = row.vatExempt || 0;
      const salesInclVat = vatExempt * (1 + VAT_RATE);
      const vatAmount = 0;
      sheet7.push([
        normalize(Moment(row.date, 'X').format('MM/DD/YYYY')),
        normalize(name),
        normalize(row.id),
        normalize(row.tin?.length > 0 ? row.tin : 'N/A'),
        normalize(formatReceiptNo(row.receiptCycle ?? 0, row.receiptNo ?? '')),
        normalize(TransactionItem.round(salesInclVat) / MP),
        normalize(TransactionItem.round(vatAmount) / MP),
        normalize(TransactionItem.round(vatExempt) / MP),
        normalize(0),
        normalize(TransactionItem.round(row.discount) / MP),
        normalize(TransactionItem.round(row.netSales) / MP),
        remarkFor(row.date),
      ]);
    }
  }

  // BIR Sales Summary Report (Annex E-1) per Discord-confirmed layout:
  //   Deductions > Discount: SC, PWD, NAAC, Solo Parent, Medal of Valor, Others
  //   Deductions: Returns, Refunds, Voids, Total Deductions
  //   Adjustment on VAT > Discount: SC, PWD, Solo Parent, Medal of Valor, Diplomat, Others
  //   Adjustment on VAT: VAT on Returns, VAT on Void, VAT on Refund, Others (=0), Total
  const sheet1: any[] = [
    [
      'Date',
      'Beginning SI No.',
      'Ending SI No.',
      'Grand Accum. Sales Ending Balance',
      'Grand Accum. Beg. Balance',
      'Sales Issued w/ Manual SI (per RR 16-2018)',
      'Gross Sales for the Day',
      'VATable Sales',
      'VAT Amount',
      'VAT-Exempt Sales',
      'Zero-Rated Sales',
      'Deductions - Discount - SC',
      'Deductions - Discount - PWD',
      'Deductions - Discount - NAAC',
      'Deductions - Discount - Solo Parent',
      'Deductions - Discount - Medal of Valor',
      'Deductions - Discount - Others',
      'Deductions - Returns',
      'Deductions - Refunds',
      'Deductions - Voids',
      'Total Deductions',
      'Adjustment on VAT - Discount - SC',
      'Adjustment on VAT - Discount - PWD',
      'Adjustment on VAT - Discount - Solo Parent',
      'Adjustment on VAT - Discount - Medal of Valor',
      'Adjustment on VAT - Discount - Diplomat',
      'Adjustment on VAT - Discount - Others',
      'Adjustment on VAT - VAT on Returns',
      'Adjustment on VAT - VAT on Void',
      'Adjustment on VAT - VAT on Refund',
      'Adjustment on VAT - Others',
      'Total VAT Adjustment',
      'VAT Payable',
      'Net Sales',
      'Sales Overrun/Overflow',
      'Total Income',
      'Reset Counter',
      'Z-Counter',
      'Remarks',
    ],
  ];

  // Convert salesSummaryData to the format needed for sheet1
  for (const date in salesSummaryData) {
    const data = salesSummaryData[date];

    // Discount sub-group of Deductions
    const discSC = TransactionItem.round(data.senior) / MP;
    const discPWD = TransactionItem.round(data.pwd) / MP;
    const discNAAC = TransactionItem.round(data.ntlAthlete) / MP;
    const discSP = TransactionItem.round(data.soloParent) / MP;
    const discMOV = TransactionItem.round(data.medalOfValor || 0) / MP;
    // "Others" = regular + commodity discounts (Diplomat moved to its own VAT-side column).
    const discOthers = TransactionItem.round((data.regular || 0) + (data.commodity || 0)) / MP;
    const returnsDed = TransactionItem.round(data.returns || 0) / MP;
    const refundsDed = TransactionItem.round(data.refunds || 0);
    const voidsDed = TransactionItem.round(data.voids || 0) / MP;
    const totalDeductions = discSC + discPWD + discNAAC + discSP + discMOV + discOthers + returnsDed + (refundsDed / MP) + voidsDed;

    // Adjustment on VAT sub-group
    const vatAdjSC = TransactionItem.round(data.scVatAdj || 0) / MP;
    const vatAdjPWD = TransactionItem.round(data.pwdVatAdj || 0) / MP;
    const vatAdjSP = TransactionItem.round(data.soloParentVatAdj || 0) / MP;
    const vatAdjMOV = TransactionItem.round(data.medalOfValorVatAdj || 0) / MP;
    const vatAdjDiplomat = TransactionItem.round(data.diplomatVatAdj || 0) / MP;
    const vatAdjOthers = TransactionItem.round(data.regularDiscountVatAdj || 0) / MP;
    const vatOnReturns = TransactionItem.round(data.vatOnReturns || 0) / MP;
    const vatOnVoid = TransactionItem.round(data.vatOnVoid || 0) / MP;
    const vatOnRefund = TransactionItem.round(data.vatOnRefund || 0) / MP;
    const vatAdjOtherOthers = 0; // Per spec: nothing contributes here.
    const totalVatAdj =
      vatAdjSC + vatAdjPWD + vatAdjSP + vatAdjMOV + vatAdjDiplomat + vatAdjOthers +
      vatOnReturns + vatOnVoid + vatOnRefund + vatAdjOtherOthers;

    const vatAmount = TransactionItem.round(data.vat) / MP;
    // VAT Payable = VAT charged − VAT adjustments (refunds/voids/returns and discount-side VAT removals).
    const vatPayable = Math.max(0, vatAmount - totalVatAdj);
    const grossSalesDay = TransactionItem.round(data.grossSales) / MP;
    // Sales issued w/ manual SI (RR 16-2018). Was hardcoded to 0, so the column
    // read 0.00 even on days a manual receipt had been issued.
    const manualSalesDay = TransactionItem.round(data.manualSales || 0) / MP;
    // Net Sales = Gross − Total Deductions − Total VAT Adjustment, floored at 0.
    const netSales = Math.max(0, grossSalesDay - totalDeductions - totalVatAdj);
    const totalIncome = netSales;

    sheet1.push([
      normalize(Moment(date, 'YYYY-MM-DD').format('MM/DD/YYYY')),
      normalize(formatReceiptNo(data.startReceiptCycle, data.startReceiptNo)),
      normalize(formatReceiptNo(data.endReceiptCycle, data.endReceiptNo)),
      '',
      '',
      normalize(manualSalesDay),
      normalize(grossSalesDay),
      normalize(TransactionItem.round(data.vatable) / MP),
      normalize(vatAmount),
      normalize(TransactionItem.round(data.vatExempt) / MP),
      normalize(TransactionItem.round(data.zeroVat) / MP),
      normalize(discSC),
      normalize(discPWD),
      normalize(discNAAC),
      normalize(discSP),
      normalize(discMOV),
      normalize(discOthers),
      normalize(returnsDed),
      normalize(refundsDed / MP),
      normalize(voidsDed),
      normalize(totalDeductions),
      normalize(vatAdjSC),
      normalize(vatAdjPWD),
      normalize(vatAdjSP),
      normalize(vatAdjMOV),
      normalize(vatAdjDiplomat),
      normalize(vatAdjOthers),
      normalize(vatOnReturns),
      normalize(vatOnVoid),
      normalize(vatOnRefund),
      normalize(vatAdjOtherOthers),
      normalize(totalVatAdj),
      normalize(vatPayable),
      normalize(netSales),
      normalize(0),
      normalize(totalIncome),
      '',
      '',
      '',
    ]);
  }

  return { sheet1, sheet2, sheet3, sheet4, sheet5, sheet6, sheet7 };
}

/** Format receipt number like printed receipts: 00-000000 (cycle + hyphen + 6-digit no). Always returns a string safe for Excel (no negative/minus). */
function formatReceiptNo(cycle: number, no: string | number): string {
  if (no === '' || no === undefined || no === null) return '';
  const cycleNum = Math.max(0, parseInt(String(cycle ?? 0), 10) || 0);
  const noNum = Math.max(0, parseInt(String(no), 10) || 0);
  const c = String(cycleNum).padStart(2, '0');
  const n6 = String(noNum).padStart(6, '0');
  return `${c}-${n6}`;
}

/**
 * True for the synthetic negative-quantity row that void / return / refund
 * appends next to the line it reverses (Transactions/index.js:1013-1021,
 * transactionTypes.js:134-142). `getTransactionSummary` skips the same shape
 * (transaction.js:142-145).
 */
function isReversalClone($itm: any): boolean {
  return !!$itm && (Number($itm.quantity) || 0) < 0;
}

/** Reversal status flagged on an original (positive-quantity) item row. */
function reversalStatusOf(val: any): string {
  if (!val) return '';
  if (val.voided) return 'VOIDED';
  if (val.returned) return 'RETURNED';
  if (val.refunded) return 'REFUNDED';
  return '';
}

function normalize(str: string | number) {
  if (typeof str === 'string') {
    return str.replace(/[,;:\t]/g, '');
  } else if (typeof str === 'number' && !isNaN(str)) {
    return parseFloat(str.toFixed(2));
  }
  return 0;
}
