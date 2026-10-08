/**
 * Differential parity test: runs the web port and the mobile app's own
 * HelperFunctions over the same fixture and asserts identical output.
 *
 * The mobile repo is the source of truth for every BIR figure, so this is the
 * check that matters when re-syncing. It self-skips when the sibling checkout is
 * absent (CI, a fresh clone), so it can never fail for the wrong reason.
 *
 * Point it at a different checkout with UTAK_MOBILE_ROOT=/path/to/utakmobileBIR.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Moment from 'moment-timezone';

import { getTransactionSummary } from './transaction';
import { calcReadingData } from './calcReadingData';
import { specialDiscounts } from './specialDiscounts';
import { getRefundSummary, getReturnSummary } from './refund';

const MOBILE_ROOT = process.env.UTAK_MOBILE_ROOT || '/Users/martinjaycyhalum/Developer/utakmobileBIR';
const FIXTURE = path.join(MOBILE_ROOT, 'transactions_list_non_reversed_new.json');
const MOBILE_READING = path.join(MOBILE_ROOT, 'src/mod_temp_bir/receipts/reading.ts');
const MOBILE_TXN = path.join(MOBILE_ROOT, 'src/HelperFunctions/transaction.js');
const MOBILE_SPECIAL_DISCOUNTS = path.join(MOBILE_ROOT, 'src/mod_temp_bir/csvs/specialDiscounts.ts');
const MOBILE_REFUND = path.join(MOBILE_ROOT, 'src/HelperFunctions/refund.js');
// Present on the retail POS (utakretailBIR) only: the basic-necessity rules.
const MOBILE_RETAIL_PRICING = path.join(MOBILE_ROOT, 'src/HelperFunctions/retailPricing.js');
const isRetailDevice = fs.existsSync(MOBILE_RETAIL_PRICING);

const available = [FIXTURE, MOBILE_READING, MOBILE_TXN, MOBILE_SPECIAL_DISCOUNTS].every(f =>
  fs.existsSync(f),
);

/** Minimal stand-in for a Firebase DataSnapshot over a keyed record. */
const asSnapshot = (record: Record<string, any>) => ({
  exists: () => Object.keys(record).length > 0,
  forEach: (cb: (snap: { key: string; val: () => any }) => void) => {
    for (const [key, val] of Object.entries(record)) cb({ key, val: () => val });
  },
});

/** Round every number in a structure so float tails don't mask real agreement. */
const round = (v: any): any => {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, round(val)]));
  }
  return v;
};

/**
 * The device's reading.ts imports the settings observable, which drags in
 * Firebase and AsyncStorage and is unloadable here. calcReadingData itself is
 * self-contained, so slice it out verbatim and supply its two local helpers.
 */
function extractMobileCalcReadingData(): string {
  const src = fs.readFileSync(MOBILE_READING, 'utf8');
  const start = src.indexOf('export const calcReadingData');
  expect(start, 'calcReadingData not found in the device reading.ts').toBeGreaterThan(-1);
  // The declaration ends at the first line that closes it at column 0.
  const end = src.indexOf('\n};', start);
  expect(end, 'calcReadingData body is unterminated').toBeGreaterThan(start);
  const body = src.slice(start, end + 3);

  const preamble = [
    "import { sumBy, first, last } from 'lodash-es';",
    'const normalizeNumber = (n: any) => {',
    '  const r = Math.round(n * 100) / 100;',
    "  return Number.isInteger(r) ? r.toString().replace(/[,;:\\t]/g, '') : r.toFixed(2).replace(/[,;:\\t]/g, '');",
    '};',
  ].join('\n');

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bir-parity-')),
    'mobileCalcReadingData.ts',
  );
  fs.writeFileSync(file, `${preamble}\n${body}\n`);
  return file;
}

/**
 * The device's specialDiscounts.ts is self-contained apart from its imports, so
 * it loads as-is once those are pointed at this repo's own models and helpers —
 * the same substitution the port makes. Everything below the import block is
 * the device's code, untouched, including its `global.C` rate lookups.
 */
function rewriteMobileSpecialDiscounts(): string {
  const src = fs.readFileSync(MOBILE_SPECIAL_DISCOUNTS, 'utf8');
  const abs = (rel: string) => path.resolve(process.cwd(), rel);
  expect(src, 'specialDiscounts.ts has no MP declaration').toContain('const MP =');
  expect(src, 'unexpected import block').toContain("from '../vendor/moment'");
  // Drop the device's own (single-line) imports; everything else is kept as
  // is, including helpers declared between the imports and MP (the retail
  // POS declares isBnpcLine there).
  const body = src
    .split('\n')
    .filter(line => !/^import .* from '.*';\s*$/.test(line))
    .join('\n');

  const imports = [
    "import Moment from 'moment-timezone';",
    "import { sortBy } from 'lodash-es';",
    `import Transaction from '${abs('src/models/Transaction')}';`,
    `import TransactionItem from '${abs('src/models/TransactionItem')}';`,
    `import { getTransactionSummary } from '${abs('src/utils/bir/transaction')}';`,
    `import { getRefundSummary, getReturnSummary, getVoidSummary } from '${abs('src/utils/bir/refund')}';`,
    'type DataSnapshot = any;',
    // The retail POS books basic necessities through its own helper; load the
    // device's copy (import-free) rather than the web port's.
    ...(src.includes('bnpcLineRate') ? [`import { bnpcLineRate } from '${MOBILE_RETAIL_PRICING}';`] : []),
  ].join('\n');

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bir-parity-sd-')),
    'mobileSpecialDiscounts.ts',
  );
  fs.writeFileSync(file, `${imports}\n${body}`);
  return file;
}

describe.skipIf(!available)('web ↔ mobile computation parity', () => {
  let fixture: Record<string, any>;
  let mobileGetTransactionSummary: (s: any) => any[];
  let mobileCalcReadingData: (...args: any[]) => Promise<any>;
  let mobileSpecialDiscounts: (opts: any) => Promise<any>;

  beforeAll(async () => {
    fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

    // The device reads its rates off a global; the web port inlines them.
    (globalThis as any).C = {
      VAT_RATE: 0.12,
      SENIOR_RATE: 0.2,
      PWD_RATE: 0.2,
      NAAC_RATE: 0.2,
      SOLO_PARENT_RATE: 0.1,
      MEDAL_OF_VALOR_RATE: 0.2,
      COMMODITY_RATE: 0.05,
    };
    (globalThis as any).global = globalThis;

    mobileGetTransactionSummary = (await import(/* @vite-ignore */ MOBILE_TXN)).getTransactionSummary;
    mobileCalcReadingData = (
      await import(/* @vite-ignore */ extractMobileCalcReadingData())
    ).calcReadingData;
    mobileSpecialDiscounts = (
      await import(/* @vite-ignore */ rewriteMobileSpecialDiscounts())
    ).specialDiscounts;
  });

  it('getTransactionSummary matches the device for every transaction', () => {
    const web = getTransactionSummary(asSnapshot(fixture));
    const mobile = mobileGetTransactionSummary(asSnapshot(fixture));

    expect(web.length).toBe(mobile.length);
    expect(web.length).toBeGreaterThan(0);
    expect(round(web)).toEqual(round(mobile));
  });

  it('specialDiscounts matches the device for all seven Annex sheets', async () => {
    // Start of the month the fixture's earliest transaction falls in — the
    // device uses it to split each total into current- and prior-month parts.
    const earliest = Math.min(...Object.keys(fixture).map(Number));
    const month = Moment.unix(earliest).startOf('month').format('X');
    const args = { snapshot: asSnapshot(fixture), month };

    const web = await specialDiscounts(args);
    const mobile = await mobileSpecialDiscounts(args);

    for (const sheet of ['sheet1', 'sheet2', 'sheet3', 'sheet4', 'sheet5', 'sheet6', 'sheet7']) {
      expect(round((web as any)[sheet]), `${sheet} differs from the device`).toEqual(
        round((mobile as any)[sheet]),
      );
    }
    // A fixture that produced only header rows would make the above vacuous.
    const rowCount = ['sheet1', 'sheet2', 'sheet3', 'sheet4', 'sheet5', 'sheet6', 'sheet7'].reduce(
      (n, s) => n + (web as any)[s].length - 1,
      0,
    );
    expect(rowCount, 'fixture produced no discount rows at all').toBeGreaterThan(0);
  });

  it('specialDiscounts matches the device on the Medal of Valor sheet', async () => {
    // The device's fixture has no MOV sale, so the sheet7 path above compares
    // headers only. Synthesize one by adding a Medal of Valor block to the
    // fixture's PAX transaction — MOV rides the same _parts machinery as SC/PWD.
    const [paxKey, paxTxn] = Object.entries(fixture).find(([, v]: [string, any]) => {
      const items = Array.isArray(v.items) ? v.items : Object.values(v.items || {});
      return items.some((i: any) => i?.paxDiscount);
    })!;
    const withMov = JSON.parse(JSON.stringify(paxTxn));
    const movItems = Array.isArray(withMov.items) ? withMov.items : Object.values(withMov.items);
    (movItems as any[]).find((i: any) => i?.paxDiscount).paxDiscount.medalOfValor = {
      tins: '', percent: 20, names: 'Juan Dela Cruz', ids: 'MOV-1', guestCount: 1,
    };
    const record = { [paxKey]: withMov };
    const args = {
      snapshot: asSnapshot(record),
      month: Moment.unix(Number(paxKey)).startOf('month').format('X'),
    };

    const web = await specialDiscounts(args);
    const mobile = await mobileSpecialDiscounts(args);

    expect((web as any).sheet7.length, 'no Medal of Valor row was produced').toBeGreaterThan(1);
    for (const sheet of ['sheet1', 'sheet2', 'sheet3', 'sheet4', 'sheet5', 'sheet6', 'sheet7']) {
      expect(round((web as any)[sheet]), `${sheet} differs from the device`).toEqual(
        round((mobile as any)[sheet]),
      );
    }
  });

  it('calcReadingData matches the device over the same summary', async () => {
    const summary = getTransactionSummary(asSnapshot(fixture));
    const web = calcReadingData(summary as any, [], undefined, undefined, null);
    const mobile = await mobileCalcReadingData(summary as any, [] as any, undefined, undefined, null);

    // vatPayable is a web-only convenience field the device does not emit.
    const { vatPayable: _webOnly, ...webComparable } = web as any;
    expect(round(webComparable)).toEqual(round(mobile));
  });
  // --- Basic necessities (retail POS only) ----------------------------------
  // SC/PWD/MOV on an isCommodity line is 5% of the regular price with VAT
  // kept, booked like a regular discount under the buyer's SC/PWD/MOV row
  // (device: utakretailBIR 0e3d8046, 4d4b5fca, b3996b17). The device fixture
  // above has no such line, so these sales exercise every booking path.
  const line = (o: Record<string, any>) => ({
    title: 'Rice 5kg', price: 500, quantity: 1, id: 'rice', category: 'Grocery', categoryOriginal: '01 Grocery',
    isCommodity: true, _defaultVatType: 'vatable', ...o,
  });
  const T0 = 1791000000; // 2026-10 (any month works; the sheets split on it)
  const BNPC_SALES: Record<string, any> = {
    [T0]: { total: 475, paymentType: 'Cash', cashier: 'A', items: [line({ individualDiscountType: 'senior', discount: '5' })] },
    [T0 + 60]: { total: 190, paymentType: 'Cash', cashier: 'A', items: [line({ price: 200, individualDiscountType: 'pwd', discount: '5' })] },
    [T0 + 120]: {
      total: 590, paymentType: 'Cash', cashier: 'A',
      items: [
        line({ price: 400, individualDiscountType: 'senior', discount: '5', bnpcRate: 0.02, bnpc: { buyerId: 'SC1', amount: 160, discount: 8 } }),
        { title: 'Shampoo', price: 198, quantity: 1, id: 'sh', category: 'Grocery', categoryOriginal: '01 Grocery', _defaultVatType: 'vatable' },
      ],
    },
    [T0 + 180]: { total: 95, paymentType: 'Cash', cashier: 'A', items: [line({ price: 100, transactionDiscountType: 'medalOfValor', discountSubtotal: 5 })] },
    [T0 + 240]: { total: 950, paymentType: 'Cash', cashier: 'A', items: [line({ price: 500, quantity: 2, individualDiscountType: 'senior', discount: '5', returned: true })] },
  };

  it.skipIf(!isRetailDevice)('basic necessities: getTransactionSummary matches the retail device', () => {
    const web = getTransactionSummary(asSnapshot(BNPC_SALES));
    const mobile = mobileGetTransactionSummary(asSnapshot(BNPC_SALES));
    expect(round(web)).toEqual(round(mobile));
    const sc = web.reduce((n: number, s: any) => n + (s.deductions?.discount?.sc || 0), 0);
    expect(sc, 'no SC discount was booked').toBeGreaterThan(0);
  });

  it.skipIf(!isRetailDevice)('basic necessities: a P500 SC line is P25 off with VAT kept', () => {
    const [s] = getTransactionSummary(asSnapshot({ [T0]: BNPC_SALES[T0] })) as any[];
    // 5% of the VAT-exclusive base (446.43 * 0.05 = 22.32) plus its VAT share
    // (2.68) is the P25 off the shelf price; the sale stays VATable.
    expect(Math.round((s.deductions.discount.sc + s.adjustmentOnVat.discount.sc) * 100) / 100).toBe(25);
    expect(Math.round((s.vatableSales + s.vatAmount) * 100) / 100).toBe(475);
    expect(s.vatExemptSales).toBe(0);
  });

  it.skipIf(!isRetailDevice)('basic necessities: specialDiscounts matches the retail device', async () => {
    const args = { snapshot: asSnapshot(BNPC_SALES), month: Moment.unix(T0).startOf('month').format('X') };
    const web = await specialDiscounts(args);
    const mobile = await mobileSpecialDiscounts(args);
    for (const sheet of ['sheet1', 'sheet2', 'sheet3', 'sheet4', 'sheet5', 'sheet6', 'sheet7']) {
      expect(round((web as any)[sheet]), `${sheet} differs from the device`).toEqual(round((mobile as any)[sheet]));
    }
  });

  it.skipIf(!isRetailDevice)('basic necessities: calcReadingData matches the retail device', async () => {
    const summary = getTransactionSummary(asSnapshot(BNPC_SALES));
    const web = calcReadingData(summary as any, [], undefined, undefined, null);
    const mobile = await mobileCalcReadingData(summary as any, [] as any, undefined, undefined, null);
    const { vatPayable: _webOnly, ...webComparable } = web as any;
    expect(round(webComparable)).toEqual(round(mobile));
  });

  it.skipIf(!isRetailDevice)('basic necessities: return and refund summaries match the retail device', async () => {
    const mobileRefund = await import(/* @vite-ignore */ MOBILE_REFUND);
    const sold = line({ individualDiscountType: 'senior', discount: '5' });
    const returns = {
      [T0 + 300]: { transactionKey: String(T0), returnNo: 1, total: 475, paymentType: 'Cash', items: [{ ...sold, returned: true, return: T0 + 300 }] },
      // Retail exchange: counts as a return, but not as cash out of the drawer.
      [T0 + 330]: {
        transactionKey: String(T0 + 60), returnNo: 2, total: 190, paymentType: 'Cash', isExchange: true,
        exchange: { id: 'EX1', credit: 190 }, items: [{ ...line({ price: 200, individualDiscountType: 'pwd', discount: '5' }), returned: true, return: T0 + 330 }],
      },
    };
    const refunds = {
      [T0 + 360]: { originalTransactionKey: String(T0), refundNo: 1, total: 475, paymentType: 'Cash', items: [{ ...sold, refund: T0 + 360 }] },
    };
    expect(round(getReturnSummary(asSnapshot(returns)))).toEqual(round(mobileRefund.getReturnSummary(asSnapshot(returns))));
    const web = getReturnSummary(asSnapshot(returns)) as any;
    expect(web.returns.length).toBe(2);
    expect(Math.round(web.cashReturnAmount * 100) / 100, 'exchange return counted as cash').toBe(500);
    expect(round(getRefundSummary(asSnapshot(refunds)))).toEqual(round(mobileRefund.getRefundSummary(asSnapshot(refunds))));
  });
});
