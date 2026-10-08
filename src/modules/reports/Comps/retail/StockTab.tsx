import React from 'react';
import Moment from 'moment-timezone';
import { useAuth } from '../../../../contexts/AuthContext';
import { loadStockOnHand, loadStockMoves, saveStockOnHand, saveStockMoves } from '../../hooks/retail';
import type { StockRow, MoveRow } from '../../../../utils/retail/reports';
import RetailReportFrame, { useDateRange, useRows, qty, type Column } from './RetailReportFrame';

const onHandColumns: Column<StockRow>[] = [
  { header: 'Category', cell: r => r.category },
  { header: 'Product', cell: r => r.name },
  { header: 'SKU', cell: r => r.sku },
  { header: 'On Hand', align: 'right', cell: r => `${qty(r.onHand)} ${r.unit}` },
  { header: 'Reorder Level', align: 'right', cell: r => (r.reorderLevel == null ? '' : qty(r.reorderLevel)) },
  { header: 'Status', cell: r => (r.low ? <span className="font-semibold text-utak-orange">LOW</span> : '') },
];

const moveColumns: Column<MoveRow>[] = [
  { header: 'Date', cell: r => Moment.unix(r.ts).format('DD MMM YYYY h:mm a') },
  { header: 'Type', cell: r => r.label },
  { header: 'Product', cell: r => r.name },
  {
    header: 'Change',
    align: 'right',
    cell: r => (
      <span className={r.delta < 0 ? 'text-utak-orange' : 'text-utak-darkgreen'}>
        {r.delta > 0 ? '+' : ''}
        {qty(r.delta)} {r.unit}
      </span>
    ),
  },
  { header: 'Reference', cell: r => r.ref },
  { header: 'Reason', cell: r => (r.type === 'count' && r.counted != null ? `Counted ${qty(r.counted)}` : r.reason) },
];

export default function StockTab() {
  const { user } = useAuth();
  const uid = user?.uid || '';
  const range = useDateRange();
  const onHand = useRows(() => (uid ? loadStockOnHand(uid) : Promise.resolve([])), [uid]);
  const moves = useRows(() => (uid ? loadStockMoves(uid, range.sttS, range.endS) : Promise.resolve([])), [
    uid, range.sttS, range.endS,
  ]);
  return (
    <>
      <RetailReportFrame
        title="Stock On Hand"
        note="As the tills last reported it. Each till keeps its own count until it syncs (Stock screen, Sync from cloud)."
        {...onHand}
        columns={onHandColumns}
        rowKey={r => r.stockKey}
        rowClass={r => (r.low ? 'bg-orange-50' : '')}
        empty="No stock recorded yet. Receive or count stock on the Stock screen of the POS."
        onSave={() => saveStockOnHand(onHand.rows)}
      />
      <RetailReportFrame
        title="Stock Moves"
        range={range}
        {...moves}
        columns={moveColumns}
        rowKey={r => r.key}
        empty="No stock moves in the selected date range."
        onSave={() => saveStockMoves(moves.rows, range.sttS, range.endS)}
      />
    </>
  );
}
