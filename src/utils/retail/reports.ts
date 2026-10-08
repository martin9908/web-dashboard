// Retail reports (UTAK Retail, tasks 5.1-5.2 of the retail spec).
//
// Pure functions over Firebase snapshots' values, so they are tested without
// a database. The data is written by the retail POS (utakretailBIR):
//   <uid>/inventory/<stockKey>    { onHand, unit, reorderLevel?, updatedAt }
//   <uid>/stockMoves/<pushKey>    { ts, type, stockKey, categoryKey, itemKey,
//                                   optionKey, delta, unit, ref, userId,
//                                   reason, counted? }
//   <uid>/returns/<key>           exchange returns: isExchange, exchange
//                                   { id, credit }, exchangeSaleKey
//   <uid>/transactions/<key>      exchange sales: exchange { id, returnKey,
//                                   returnRef, originalKey, credit }; lines
//                                   with overridePrice / originalPrice
// stockKey = categoryKey__itemKey[__optionKey]. Nothing here is a BIR figure:
// the readings, journal and eSales are untouched by these reports.

export const MOVE_LABELS: Record<string, string> = {
  sale: 'Sale',
  void: 'Void',
  return: 'Return',
  refund: 'Refund',
  exchange_in: 'Exchange (returned)',
  exchange_out: 'Exchange (given)',
  receive: 'Received',
  adjust: 'Adjustment',
  count: 'Stock count',
  opening: 'Opening stock',
};

const round2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;

export interface ProductInfo {
  category: string;
  name: string;
  sku: string;
  barcode: string;
  unit: string;
}

/** Product names and codes per stockKey, from a menu snapshot. */
export function productIndex(menu: any): Map<string, ProductInfo> {
  const out = new Map<string, ProductInfo>();
  for (const categoryKey of Object.keys(menu || {})) {
    const category = menu[categoryKey];
    if (!category || typeof category !== 'object') continue;
    // Category keys sort with a numeric prefix ("01 Grocery"); show the name.
    const categoryName = categoryKey.replace(/^\d+\s+/, '');
    for (const itemKey of Object.keys(category)) {
      const item = category[itemKey];
      if (!item || typeof item !== 'object') continue;
      const base = {
        category: categoryName,
        name: String(item.title ?? itemKey),
        sku: String(item.sku ?? ''),
        barcode: String(item.barcode ?? ''),
        unit: String(item.unit ?? 'pc'),
      };
      out.set(`${categoryKey}__${itemKey}`, base);
      const options = item.options && typeof item.options === 'object' ? item.options : {};
      for (const optionKey of Object.keys(options)) {
        const option = options[optionKey];
        if (!option) continue;
        out.set(`${categoryKey}__${itemKey}__${optionKey}`, {
          ...base,
          name: option.optionText ? `${base.name} (${option.optionText})` : base.name,
          sku: String(option.sku ?? base.sku),
          barcode: String(option.barcode ?? ''),
        });
      }
    }
  }
  return out;
}

/** A product that is no longer in the menu still shows, by its key. */
const describe = (products: Map<string, ProductInfo>, stockKey: string): ProductInfo =>
  products.get(stockKey) || {
    category: String(stockKey).split('__')[0].replace(/^\d+\s+/, ''),
    name: `${stockKey} (not in menu)`,
    sku: '',
    barcode: '',
    unit: 'pc',
  };

export interface StockRow extends ProductInfo {
  stockKey: string;
  onHand: number;
  reorderLevel: number | null;
  low: boolean;
  updatedAt: number | null;
}

/** On-hand per product, low stock first, then by category and name. */
export function stockOnHandRows(inventory: any, menu: any): StockRow[] {
  const products = productIndex(menu);
  const rows: StockRow[] = [];
  for (const stockKey of Object.keys(inventory || {})) {
    const entry = inventory[stockKey] || {};
    const info = describe(products, stockKey);
    const onHand = round3(entry.onHand);
    const level = Number(entry.reorderLevel);
    const reorderLevel = Number.isFinite(level) && level > 0 ? level : null;
    rows.push({
      ...info,
      unit: String(entry.unit ?? info.unit),
      stockKey,
      onHand,
      reorderLevel,
      low: reorderLevel != null && onHand <= reorderLevel,
      updatedAt: Number(entry.updatedAt) || null,
    });
  }
  return rows.sort(
    (a, b) =>
      Number(b.low) - Number(a.low) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );
}

export interface MoveRow {
  key: string;
  ts: number;
  type: string;
  label: string;
  stockKey: string;
  name: string;
  sku: string;
  delta: number;
  counted: number | null;
  unit: string;
  ref: string;
  user: string;
  reason: string;
}

/** Moves with ts in [sttS, endS], oldest first. Training data never reaches stockMoves. */
export function stockMoveRows(moves: any, menu: any, sttS: number, endS: number): MoveRow[] {
  const products = productIndex(menu);
  const rows: MoveRow[] = [];
  for (const key of Object.keys(moves || {})) {
    const m = moves[key];
    if (!m || !m.stockKey) continue;
    const ts = Number(m.ts) || 0;
    if (ts < sttS || ts > endS) continue;
    const info = describe(products, m.stockKey);
    rows.push({
      key,
      ts,
      type: String(m.type || ''),
      label: MOVE_LABELS[m.type] || String(m.type || ''),
      stockKey: m.stockKey,
      name: info.name,
      sku: info.sku,
      delta: round3(m.delta),
      counted: m.counted == null ? null : round3(m.counted),
      unit: String(m.unit || info.unit),
      ref: String(m.ref ?? ''),
      user: String(m.userId ?? ''),
      reason: String(m.reason ?? ''),
    });
  }
  return rows.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
}

const lineName = (it: any) => (it?.option ? `${it.title} (${it.option})` : String(it?.title ?? ''));
const items = (rec: any): any[] =>
  Array.isArray(rec?.items) ? rec.items.filter(Boolean) : Object.values(rec?.items || {}).filter(Boolean);

/** "CC-NNNNNN" as the POS prints it; '' when there is no number. */
export const formatSI = (cycle: unknown, no: unknown) =>
  no == null || no === ''
    ? ''
    : `${String(Number(cycle) || 0).padStart(2, '0')}-${String(no).padStart(6, '0')}`;

export interface ExchangeRow {
  returnKey: string;
  ts: number;
  exchangeId: string;
  returnNo: string;
  originalSI: string;
  returnedItems: string;
  credit: number;
  saleKey: string;
  newSI: string;
  newItems: string;
  newTotal: number;
  paidOnTop: number;
  cashier: string;
  /** False when the return was made but no replacement sale is linked yet. */
  completed: boolean;
}

/**
 * One row per exchange, from the exchange returns in range and their linked
 * sales (`sales` maps sale key -> transaction value, already fetched).
 */
export function exchangeRows(returns: any, sales: Record<string, any>): ExchangeRow[] {
  const rows: ExchangeRow[] = [];
  for (const returnKey of Object.keys(returns || {})) {
    const r = returns[returnKey];
    if (!r || !r.isExchange || r.trainingMode) continue;
    const credit = round2(r.exchange?.credit);
    const saleKey = r.exchangeSaleKey ? String(r.exchangeSaleKey) : '';
    const sale = saleKey ? sales[saleKey] : null;
    const back = items(r).filter((it: any) => it.returned && Number(it.quantity) > 0);
    const newTotal = sale ? round2(sale.total ?? sale.amountDue) : 0;
    rows.push({
      returnKey,
      ts: Number(returnKey) || 0,
      exchangeId: String(r.exchange?.id ?? ''),
      returnNo: r.returnNo != null ? `RET #${String(r.returnNo).padStart(6, '0')}` : '',
      originalSI: formatSI(r.receiptCycle, r.receiptNo),
      returnedItems: back.map((it: any) => `${lineName(it)} x${round3(it.quantity)}`).join('; '),
      credit,
      saleKey,
      newSI: sale ? formatSI(sale.receiptCycle, sale.receiptNo) : '',
      newItems: sale
        ? items(sale)
            .filter((it: any) => Number(it.quantity) > 0)
            .map((it: any) => `${lineName(it)} x${round3(it.quantity)}`)
            .join('; ')
        : '',
      newTotal,
      paidOnTop: sale ? round2(Math.max(0, newTotal - credit)) : 0,
      cashier: String(r.cashier ?? ''),
      completed: !!sale,
    });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

export interface OverrideRow {
  key: string;
  ts: number;
  si: string;
  item: string;
  quantity: number;
  originalPrice: number;
  overridePrice: number;
  difference: number;
  approver: string;
  reason: string;
  cashier: string;
}

/**
 * Every price-overridden line in the transactions given. Same rows as the
 * POS's Price Overrides report (HelperFunctions/retailPricing.overrideRows).
 */
export function overrideRows(transactions: any): OverrideRow[] {
  const rows: OverrideRow[] = [];
  for (const key of Object.keys(transactions || {})) {
    const txn = transactions[key];
    if (!txn || txn.trainingMode) continue;
    for (const it of items(txn)) {
      if (it.overridePrice == null || Number(it.quantity) < 0) continue;
      const quantity = Number(it.quantity) || 0;
      rows.push({
        key,
        ts: Number(txn.timestamp || key) || 0,
        si: formatSI(txn.receiptCycle, txn.receiptNo),
        item: lineName(it),
        quantity,
        originalPrice: Number(it.originalPrice),
        overridePrice: Number(it.overridePrice),
        difference: round2((Number(it.overridePrice) - Number(it.originalPrice)) * quantity),
        approver: String(it.overrideBy ?? ''),
        reason: String(it.overrideReason ?? ''),
        cashier: String(txn.cashier ?? ''),
      });
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/** True for a business set up by the retail app (settings/serviceStyle). */
export const isRetailStyle = (serviceStyle: unknown) => serviceStyle === 'retail';
