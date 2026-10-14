// Shared frame for the retail report tabs: date range, Save Report button,
// loading / empty states and a plain table, styled like VoidsTab.
import React from 'react';
import Moment from 'moment-timezone';
import { Menu, Download, Loader } from 'lucide-react';

export interface Column<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
}

export const peso = (n: number) =>
  `₱${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const qty = (n: number) =>
  (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });

export function useDateRange(daysBack = 6) {
  const [sttS, setSttS] = React.useState(() => Math.floor(Moment().subtract(daysBack, 'days').startOf('day').unix()));
  const [endS, setEndS] = React.useState(() => Math.floor(Moment().endOf('day').unix()));
  const set = (type: 'start' | 'end', value: string) => {
    const ts = Math.floor(new Date(value).getTime() / 1000);
    if (!Number.isFinite(ts)) return;
    if (type === 'start') setSttS(ts);
    else setEndS(ts);
  };
  return { sttS, endS, set };
}

interface FrameProps<T> {
  title: string;
  note?: React.ReactNode;
  range?: { sttS: number; endS: number; set: (type: 'start' | 'end', value: string) => void };
  loading: boolean;
  error?: string | null;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string;
  rowClass?: (row: T) => string;
  empty: string;
  onSave: () => Promise<unknown>;
}

export default function RetailReportFrame<T>({
  title, note, range, loading, error, rows, columns, rowKey, rowClass, empty, onSave,
}: FrameProps<T>) {
  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    try {
      setSaving(true);
      await onSave();
    } catch (e: any) {
      console.error(`Error saving ${title}:`, e);
      alert(`Error downloading report: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };
  const input =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-utak-darkseagreen focus:border-transparent';
  return (
    <div className="max-w-6xl mx-auto mb-6">
      <div className="bg-white rounded-lg shadow-sm p-6 mb-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-2">
            <Menu size={28} className="text-gray-600" />
            <h2 className="font-semibold text-gray-800">{title}</h2>
          </div>
          {range && (
            <div className="flex flex-col md:flex-row gap-4 flex-1 md:max-w-2xl">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">From:</label>
                <input
                  type="datetime-local"
                  value={Moment.unix(range.sttS).format('YYYY-MM-DDTHH:mm')}
                  onChange={e => range.set('start', e.target.value)}
                  className={input}
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-600 mb-1">To:</label>
                <input
                  type="datetime-local"
                  value={Moment.unix(range.endS).format('YYYY-MM-DDTHH:mm')}
                  onChange={e => range.set('end', e.target.value)}
                  className={input}
                />
              </div>
            </div>
          )}
          <button
            onClick={save}
            disabled={!rows.length || saving || loading}
            className="flex items-center justify-center gap-2 px-6 py-2 rounded-lg font-semibold text-white transition-opacity disabled:opacity-50 disabled:cursor-not-allowed bg-utak-darkseagreen hover:bg-utak-darkgreen">
            {saving ? <Loader size={20} className="animate-spin" /> : <Download size={20} />}
            {saving ? 'Saving...' : 'Save Report'}
          </button>
        </div>
        {note && <p className="text-xs text-gray-500 mt-3">{note}</p>}
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader size={32} className="animate-spin text-utak-darkseagreen" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-red-600 text-center">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-gray-500 text-center">{empty}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {columns.map(c => (
                    <th
                      key={c.header}
                      className={`px-4 py-3 text-xs font-medium text-gray-700 uppercase ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {rows.map((row, i) => (
                  <tr key={rowKey(row, i)} className={`hover:bg-gray-50 ${rowClass ? rowClass(row) : ''}`}>
                    {columns.map(c => (
                      <td
                        key={c.header}
                        className={`px-4 py-3 text-sm text-gray-900 ${c.align === 'right' ? 'text-right' : ''}`}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Load rows whenever the inputs change; returns { loading, error, rows }. */
export function useRows<T>(load: () => Promise<T[]>, deps: React.DependencyList) {
  const [state, setState] = React.useState<{ loading: boolean; error: string | null; rows: T[] }>({
    loading: true,
    error: null,
    rows: [],
  });
  React.useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    load()
      .then(rows => live && setState({ loading: false, error: null, rows }))
      .catch(e => live && setState({ loading: false, error: String(e?.message || e), rows: [] }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
