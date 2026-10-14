// Loaders and Excel exports for the retail report tabs (StockTab,
// ExchangesTab, OverridesTab). Shown only to businesses whose
// settings/serviceStyle is 'retail' (useIsRetail), so F&B accounts on the
// same deploy never see them. Builders live in utils/retail/reports.
import { useEffect, useState } from 'react';
import { ref, query, orderByKey, orderByChild, startAt, endAt, get } from 'firebase/database';
import { database } from '../../../config/firebase';
import { useAuth } from '../../../contexts/AuthContext';
import exportUtils from '../../../utils/exportUtils';
import Moment from 'moment-timezone';
import {
  stockOnHandRows,
  stockMoveRows,
  exchangeRows,
  overrideRows,
  isRetailStyle,
  type StockRow,
  type MoveRow,
  type ExchangeRow,
  type OverrideRow,
} from '../../../utils/retail/reports';

const val = async (path: string) => {
  const snap = await get(ref(database, path));
  return snap.exists() ? snap.val() : null;
};

const byKeyRange = async (path: string, sttS: number, endS: number) => {
  const snap = await get(query(ref(database, path), orderByKey(), startAt(`${sttS}`), endAt(`${endS}`)));
  return snap.exists() ? snap.val() : {};
};

/** null while loading, then whether this business runs the retail app. */
export function useIsRetail(): boolean | null {
  const { user } = useAuth();
  const [retail, setRetail] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    if (!user?.uid) {
      setRetail(false);
      return;
    }
    val(`${user.uid}/settings/serviceStyle`)
      .then(style => live && setRetail(isRetailStyle(style)))
      .catch(() => live && setRetail(false));
    return () => {
      live = false;
    };
  }, [user?.uid]);
  return retail;
}

export async function loadStockOnHand(uid: string): Promise<StockRow[]> {
  const [inventory, menu] = await Promise.all([val(`${uid}/inventory`), val(`${uid}/menu`)]);
  return stockOnHandRows(inventory || {}, menu || {});
}

// Moves have push keys, so the date range is on the `ts` child. Add
// ".indexOn": ["ts"] under $uid/stockMoves in the RTDB rules; without it the
// query still works but Firebase filters on the client and logs a warning.
export async function loadStockMoves(uid: string, sttS: number, endS: number): Promise<MoveRow[]> {
  const [moves, menu] = await Promise.all([
    get(query(ref(database, `${uid}/stockMoves`), orderByChild('ts'), startAt(sttS), endAt(endS))).then(s =>
      s.exists() ? s.val() : {},
    ),
    val(`${uid}/menu`),
  ]);
  return stockMoveRows(moves, menu || {}, sttS, endS);
}

export async function loadExchanges(uid: string, sttS: number, endS: number): Promise<ExchangeRow[]> {
  const returns = await byKeyRange(`${uid}/returns`, sttS, endS);
  const saleKeys = Object.values(returns || {})
    .filter((r: any) => r?.isExchange && r.exchangeSaleKey)
    .map((r: any) => String(r.exchangeSaleKey));
  const sales: Record<string, any> = {};
  await Promise.all(
    saleKeys.map(async k => {
      const sale = await val(`${uid}/transactions/${k}`);
      if (sale) sales[k] = sale;
    }),
  );
  return exchangeRows(returns, sales);
}

export async function loadOverrides(uid: string, sttS: number, endS: number): Promise<OverrideRow[]> {
  return overrideRows(await byKeyRange(`${uid}/transactions`, sttS, endS));
}

const when = (ts: number | null) => (ts ? Moment.unix(ts).format('YYYY-MM-DD HH:mm:ss') : '');
const range = (sttS: number, endS: number) => exportUtils.formatTimeRange(sttS, endS);
const save = (sheets: Record<string, any[][]>, filename: string) =>
  exportUtils.downloadExcelFile(sheets, filename, {
    trainingMode: (globalThis as any).isInTrainingMode || false,
  });

export function saveStockOnHand(rows: StockRow[]) {
  const data: any[][] = [
    ['Category', 'Product', 'SKU', 'Barcode', 'Unit', 'On Hand', 'Reorder Level', 'Low', 'Updated'],
    ...rows.map(r => [
      r.category, r.name, r.sku, r.barcode, r.unit, r.onHand, r.reorderLevel ?? '', r.low ? 'LOW' : '', when(r.updatedAt),
    ]),
  ];
  return save({ 'Stock On Hand': data }, `Stock On Hand ${Moment().format('YYYY-MM-DD HHmm')}`);
}

export function saveStockMoves(rows: MoveRow[], sttS: number, endS: number) {
  const data: any[][] = [
    ['Date', 'Type', 'Product', 'SKU', 'Change', 'Counted', 'Unit', 'Reference', 'User', 'Reason'],
    ...rows.map(r => [when(r.ts), r.label, r.name, r.sku, r.delta, r.counted ?? '', r.unit, r.ref, r.user, r.reason]),
  ];
  const t = range(sttS, endS);
  return save({ 'Stock Moves': data }, `Stock Moves ${t.start} to ${t.end}`);
}

export function saveExchanges(rows: ExchangeRow[], sttS: number, endS: number) {
  const data: any[][] = [
    ['Date', 'Exchange ID', 'Return No', 'Original SI', 'Returned', 'Credit', 'New SI', 'Replacement', 'New Total', 'Paid On Top', 'Cashier', 'Status'],
    ...rows.map(r => [
      when(r.ts), r.exchangeId, r.returnNo, r.originalSI, r.returnedItems, r.credit, r.newSI, r.newItems,
      r.completed ? r.newTotal : '', r.completed ? r.paidOnTop : '', r.cashier, r.completed ? 'Completed' : 'No replacement sale',
    ]),
  ];
  const t = range(sttS, endS);
  return save({ Exchanges: data }, `Exchanges ${t.start} to ${t.end}`);
}

export function saveOverrides(rows: OverrideRow[], sttS: number, endS: number) {
  const data: any[][] = [
    ['Date', 'SI No', 'Item', 'Qty', 'Catalog Price', 'Sold At', 'Difference', 'Approved By', 'Reason', 'Cashier'],
    ...rows.map(r => [
      when(r.ts), r.si, r.item, r.quantity, r.originalPrice, r.overridePrice, r.difference, r.approver, r.reason, r.cashier,
    ]),
  ];
  const t = range(sttS, endS);
  return save({ 'Price Overrides': data }, `Price Overrides ${t.start} to ${t.end}`);
}
