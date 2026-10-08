import React from 'react';
import Moment from 'moment-timezone';
import { useAuth } from '../../../../contexts/AuthContext';
import { loadExchanges, saveExchanges } from '../../hooks/retail';
import type { ExchangeRow } from '../../../../utils/retail/reports';
import RetailReportFrame, { useDateRange, useRows, peso, type Column } from './RetailReportFrame';

const columns: Column<ExchangeRow>[] = [
  { header: 'Date', cell: r => Moment.unix(r.ts).format('DD MMM YYYY h:mm a') },
  { header: 'Return', cell: r => r.returnNo },
  { header: 'Original SI', cell: r => r.originalSI },
  { header: 'Returned', cell: r => r.returnedItems },
  { header: 'Credit', align: 'right', cell: r => peso(r.credit) },
  { header: 'New SI', cell: r => r.newSI || <span className="text-utak-orange">No replacement sale</span> },
  { header: 'Replacement', cell: r => r.newItems },
  { header: 'Paid On Top', align: 'right', cell: r => (r.completed ? peso(r.paidOnTop) : '') },
];

export default function ExchangesTab() {
  const { user } = useAuth();
  const uid = user?.uid || '';
  const range = useDateRange();
  const data = useRows(() => (uid ? loadExchanges(uid, range.sttS, range.endS) : Promise.resolve([])), [
    uid, range.sttS, range.endS,
  ]);
  return (
    <RetailReportFrame
      title="Exchanges"
      note="Each exchange is a Return slip plus a new Sales Invoice paid first by Exchange Credit. Both also appear in Returns and Transactions."
      range={range}
      {...data}
      columns={columns}
      rowKey={r => r.returnKey}
      empty="No exchanges in the selected date range."
      onSave={() => saveExchanges(data.rows, range.sttS, range.endS)}
    />
  );
}
