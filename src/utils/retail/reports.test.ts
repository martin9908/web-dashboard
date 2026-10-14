import { describe, expect, it } from 'vitest';
import {
  productIndex,
  stockOnHandRows,
  stockMoveRows,
  exchangeRows,
  overrideRows,
  formatSI,
  isRetailStyle,
} from './reports';

// Shapes as the retail POS writes them (utakretailBIR stockLedger.js,
// retailPricing.js, exchange.js, Screens/Transactions).
const MENU = {
  '01 Grocery': {
    rice: { title: 'Rice', sku: 'R-1', barcode: '480100', unit: 'kg' },
    tee: {
      title: 'Tee', sku: 'T', options: { s: { optionText: 'Small', sku: 'T-S', barcode: '480200' }, l: { optionText: 'Large' } },
    },
  },
};

describe('productIndex', () => {
  it('names items and options by stockKey, options inheriting the item SKU', () => {
    const idx = productIndex(MENU);
    expect(idx.get('01 Grocery__rice')).toEqual({ category: 'Grocery', name: 'Rice', sku: 'R-1', barcode: '480100', unit: 'kg' });
    expect(idx.get('01 Grocery__tee__s')?.name).toBe('Tee (Small)');
    expect(idx.get('01 Grocery__tee__s')?.sku).toBe('T-S');
    expect(idx.get('01 Grocery__tee__l')?.sku).toBe('T');
  });
});

describe('stockOnHandRows', () => {
  const inventory = {
    '01 Grocery__rice': { onHand: 12.5, unit: 'kg', reorderLevel: 20, updatedAt: 100 },
    '01 Grocery__tee__s': { onHand: 7, unit: 'pc' },
    '02 Gone__x': { onHand: 1 },
  };
  const rows = stockOnHandRows(inventory, MENU);

  it('lists low stock first', () => {
    expect(rows[0].stockKey).toBe('01 Grocery__rice');
    expect(rows[0].low).toBe(true);
  });
  it('keeps decimals and the unit', () => {
    expect(rows[0].onHand).toBe(12.5);
    expect(rows[0].unit).toBe('kg');
  });
  it('shows a product no longer in the menu by its key', () => {
    expect(rows.find(r => r.stockKey === '02 Gone__x')?.name).toBe('02 Gone__x (not in menu)');
  });
  it('no reorder level means never low', () => {
    expect(rows.find(r => r.stockKey === '01 Grocery__tee__s')).toMatchObject({ reorderLevel: null, low: false });
  });
});

describe('stockMoveRows', () => {
  const moves = {
    b: { ts: 200, type: 'sale', stockKey: '01 Grocery__rice', delta: -1.25, unit: 'kg', ref: 'SI 00-000001', userId: 'Ana' },
    a: { ts: 100, type: 'count', stockKey: '01 Grocery__rice', delta: -0.5, counted: 13.75, unit: 'kg', reason: null },
    c: { ts: 999, type: 'receive', stockKey: '01 Grocery__rice', delta: 10, unit: 'kg' },
  };
  it('filters by date range and sorts oldest first, with labels', () => {
    const rows = stockMoveRows(moves, MENU, 100, 500);
    expect(rows.map(r => r.key)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ label: 'Stock count', counted: 13.75, name: 'Rice' });
    expect(rows[1]).toMatchObject({ label: 'Sale', delta: -1.25, ref: 'SI 00-000001', user: 'Ana' });
  });
});

describe('exchangeRows', () => {
  const returns = {
    '1000': {
      isExchange: true, returnNo: 12, receiptCycle: 0, receiptNo: 5, cashier: 'Ana',
      exchange: { id: 'EX1000AB', credit: 499 }, exchangeSaleKey: '1100',
      items: [{ title: 'Tee', option: 'Small', quantity: 1, price: 499, returned: true }, { title: 'Socks', quantity: 1, price: 99 }],
    },
    '1050': { isExchange: true, returnNo: 13, exchange: { id: 'EX2', credit: 100 }, items: [] },
    '1060': { returnNo: 14, items: [] },
  };
  const sales = {
    '1100': { receiptCycle: 0, receiptNo: 9, total: 650, items: [{ title: 'Tee', option: 'Large', quantity: 1, price: 650 }] },
  };
  const rows = exchangeRows(returns, sales);

  it('lists exchange returns only', () => {
    expect(rows.map(r => r.returnKey)).toEqual(['1000', '1050']);
  });
  it('links the return to its replacement sale', () => {
    expect(rows[0]).toMatchObject({
      exchangeId: 'EX1000AB', returnNo: 'RET #000012', originalSI: '00-000005', returnedItems: 'Tee (Small) x1',
      credit: 499, newSI: '00-000009', newItems: 'Tee (Large) x1', newTotal: 650, paidOnTop: 151, completed: true,
    });
  });
  it('flags a return with no replacement sale', () => {
    expect(rows[1]).toMatchObject({ completed: false, newSI: '', paidOnTop: 0 });
  });
});

describe('overrideRows', () => {
  it('lists overridden lines with the difference, skipping training and reversal lines', () => {
    const rows = overrideRows({
      '2000': {
        receiptCycle: 0, receiptNo: 3, cashier: 'Ana',
        items: [
          { title: 'Shirt', quantity: 2, price: 200, originalPrice: 250, overridePrice: 200, overrideBy: 'Bo (admin PIN)', overrideReason: 'price match' },
          { title: 'Shirt', quantity: -1, price: 200, originalPrice: 250, overridePrice: 200 },
          { title: 'Cap', quantity: 1, price: 150 },
        ],
      },
      '2100': { trainingMode: true, items: [{ title: 'X', quantity: 1, originalPrice: 10, overridePrice: 5 }] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ si: '00-000003', item: 'Shirt', difference: -100, approver: 'Bo (admin PIN)', reason: 'price match' });
  });
});

describe('helpers', () => {
  it('formatSI pads like the POS', () => {
    expect(formatSI(1, 23)).toBe('01-000023');
    expect(formatSI(null, null)).toBe('');
  });
  it('only the retail style is retail', () => {
    expect(isRetailStyle('retail')).toBe(true);
    expect(isRetailStyle('fineDining')).toBe(false);
    expect(isRetailStyle(undefined)).toBe(false);
  });
});
