import React from 'react';
import Moment from 'moment-timezone';
import { useAuth } from '../../../../contexts/AuthContext';
import { loadOverrides, saveOverrides } from '../../hooks/retail';
import type { OverrideRow } from '../../../../utils/retail/reports';
import RetailReportFrame, { useDateRange, useRows, peso, qty, type Column } from './RetailReportFrame';

const columns: Column<OverrideRow>[] = [
  { header: 'Date', cell: r => Moment.unix(r.ts).format('DD MMM YYYY h:mm a') },
  { header: 'SI No', cell: r => r.si },
  { header: 'Item', cell: r => r.item },
  { header: 'Qty', align: 'right', cell: r => qty(r.quantity) },
  { header: 'Catalog Price', align: 'right', cell: r => peso(r.originalPrice) },
  { header: 'Sold At', align: 'right', cell: r => peso(r.overridePrice) },
  {
    header: 'Difference',
    align: 'right',
    cell: r => <span className={r.difference < 0 ? 'text-utak-orange' : ''}>{peso(r.difference)}</span>,
  },
  { header: 'Approved By', cell: r => r.approver },
  { header: 'Reason', cell: r => r.reason },
];

export default function OverridesTab() {
  const { user } = useAuth();
  const uid = user?.uid || '';
  const range = useDateRange();
  const data = useRows(() => (uid ? loadOverrides(uid, range.sttS, range.endS) : Promise.resolve([])), [
    uid, range.sttS, range.endS,
  ]);
  return (
    <RetailReportFrame
      title="Price Overrides"
      note="Lines sold at a price other than the catalog price, with who approved it."
      range={range}
      {...data}
      columns={columns}
      rowKey={(r, i) => `${r.key}-${i}`}
      empty="No price overrides in the selected date range."
      onSave={() => saveOverrides(data.rows, range.sttS, range.endS)}
    />
  );
}
