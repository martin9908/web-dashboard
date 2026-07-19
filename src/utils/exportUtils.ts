// Web-compatible export utilities for CSV and XLSX files
import * as XLSX from 'xlsx';
import Transaction from '../models/Transaction';
import Moment from 'moment-timezone';
import { ref, query, orderByKey, startAt, endAt, get } from 'firebase/database';
import { database } from '../config/firebase';

export interface ExportOptions {
  filename?: string;
  trainingMode?: boolean;
}

// Normalize function to clean CSV data (from mobile implementation)
function normalize(str: any): string | number {
  if (typeof str === 'string') {
    return str.replace(/[,;:\t]/g, '');
  } else {
    return parseFloat((str || 0).toFixed(2));
  }
}

// Browser download helper
function downloadFile(content: string | ArrayBuffer, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

// CSV Export Functions
export async function downloadCsvFile(csvContent: string[][], filename: string, options: ExportOptions = {}) {
  try {
    if (!csvContent || !Array.isArray(csvContent) || csvContent.length === 0) {
      throw new Error('No data to export');
    }

    // Proper CSV escaping: quote any cell containing a comma, quote, or newline
    // (peso amounts like "5,200.00" contain commas — without this the horizontal
    // reading columns would split apart).
    const escapeCell = (cell: any): string => {
      const s = cell == null ? '' : String(cell);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvString = csvContent.map(row =>
      Array.isArray(row) ? row.map(escapeCell).join(',') : escapeCell(row)
    ).join('\n');

    const finalFilename = `${options.trainingMode ? '[TRAINING MODE] ' : ''}${filename}.csv`;

    downloadFile(csvString, finalFilename, 'text/csv;charset=utf-8;');

    return Promise.resolve(finalFilename);
  } catch (error) {
    console.error('Error downloading CSV file:', error);
    throw new Error(`Failed to download CSV: ${error.message || 'Unknown error'}`);
  }
}

// XLSX Export Function
export async function downloadExcelFile(
  workbookData: { [sheetName: string]: any[][] },
  filename: string,
  options: ExportOptions = {}
) {
  try {
    if (!workbookData || typeof workbookData !== 'object' || Object.keys(workbookData).length === 0) {
      throw new Error('No data to export');
    }

    // Create a new workbook
    const wb = XLSX.utils.book_new();

    // Add each sheet to the workbook
    Object.entries(workbookData).forEach(([sheetName, data]) => {
      if (data && Array.isArray(data) && data.length > 0) {
        const ws = XLSX.utils.aoa_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      }
    });

    // Generate file
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const finalFilename = `${options.trainingMode ? '[TRAINING MODE] ' : ''}${filename}.xlsx`;

    downloadFile(wbout, finalFilename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    return Promise.resolve(finalFilename);
  } catch (error) {
    console.error('Error downloading Excel file:', error);
    throw new Error(`Failed to download Excel: ${error.message || 'Unknown error'}`);
  }
}

// Transaction CSV generation (equivalent to mobile transactions function)
export function generateTransactionsCsv(transactions: any[], isManual = false): string[][] {
  const headers = !isManual
    ? ['Date', 'Time', 'Amount Due', 'Service']
    : ['Date', 'Time', 'Manual SI/OR', 'Receipt Number', 'Amount Due', 'Service'];

  const data = [headers];
  const MP = Transaction.MONEY_PRECISION;

  transactions.forEach(txnData => {
    let txn: Transaction;

    // Handle both plain objects and Transaction instances
    if (txnData instanceof Transaction) {
      txn = txnData;
    } else {
      // Create Transaction from Firebase data or plain object
      const key = txnData.key || (typeof txnData === 'object' && Object.keys(txnData)[0]);
      const val = txnData.val ? txnData.val() : txnData;
      txn = new Transaction({ key, val });
    }

    const time = Moment.unix(Number(txn.key));
    const row = [];

    row.push(normalize(time.format('D MMM YYYY')));
    row.push(normalize(time.format('h:mma')));

    if (isManual) {
      row.push(txn.original.manualReference || '');
      row.push(txn.original.receiptNo || '');
    }

    row.push(normalize(txn.$amountDue / MP));
    row.push(normalize(txn.$service / MP));

    data.push(row);
  });

  return data;
}

// Generate refunds CSV (placeholder - would need actual implementation)
export function generateRefundsCsv(startTimestamp: number, endTimestamp: number): string[][] {
  // This would need to be implemented with actual refunds data from Firebase
  // For now, return basic structure
  const headers = ['Date', 'Time', 'Original Receipt', 'Refund Amount', 'Reason'];
  return [headers];
}

// Helper function to get current user UID from localStorage
function getCurrentUserUid(): string | null {
  try {
    const storedUser = localStorage.getItem("@webdashboard:user");
    if (storedUser) {
      const user = JSON.parse(storedUser);
      return user.uid || null;
    }
    return null;
  } catch (error) {
    console.warn("Error getting user from localStorage:", error);
    return null;
  }
}

/**
 * Turn one or more receipt-style reading texts into a HORIZONTAL table:
 * a single header row of field labels + one data row per reading (same layout
 * as the Detailed Sales Summary). Each "Label: value" / "Label   value" line
 * becomes a column; dividers, blanks and value-less section titles are skipped.
 * Repeated labels within one reading are disambiguated (e.g. "VAT Amount (2)").
 */
function readingTextsToHorizontal(texts: string[]): string[][] {
  const headerOrder: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];

  for (const text of texts) {
    if (!text) continue;
    const row: Record<string, string> = {};
    const counts: Record<string, number> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r/g, '');
      // Label and value are separated by 2+ spaces in the receipt layout.
      const m = line.match(/^(.*?\S)\s{2,}(\S.*)$/);
      if (!m) continue;
      const label = m[1].replace(/:\s*$/, '').trim();
      const value = m[2].trim();
      if (!label) continue;
      counts[label] = (counts[label] || 0) + 1;
      const key = counts[label] > 1 ? `${label} (${counts[label]})` : label;
      row[key] = value;
      if (!seen.has(key)) {
        seen.add(key);
        headerOrder.push(key);
      }
    }
    if (Object.keys(row).length) rows.push(row);
  }

  if (!headerOrder.length) return [];
  return [headerOrder, ...rows.map((r) => headerOrder.map((h) => r[h] ?? ''))];
}

// Generate Z Reading CSV from Firebase pre-calculated readings
export async function generateZCsv(startDate: string, endDate?: string): Promise<string[][]> {
  const userUid = getCurrentUserUid();
  if (!userUid) {
    return [['Error: User not authenticated. Please log in to generate reports.']];
  }

  const sttS = Moment(startDate, 'YYMMDD').startOf('day').format('X');
  const endS = Moment(endDate || startDate, 'YYMMDD').endOf('day').format('X');

  try {
    const journalRef = ref(database, `${userUid}/journal`);
    const journalQuery = query(journalRef, orderByKey(), startAt(sttS), endAt(endS));
    const snapshot = await get(journalQuery);

    const zTexts: string[] = [];
    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const val = child.val();
        if (val?.zReading) zTexts.push(val.zReading);
      });
    }

    const horizontal = readingTextsToHorizontal(zTexts);
    if (horizontal.length) return horizontal;
  } catch (firebaseError) {
    console.warn('Error fetching Z reading from Firebase:', firebaseError);
  }

  return [
    ['Z-READING REPORT'],
    ['Period', `${startDate}${endDate ? ` to ${endDate}` : ''}`],
    [],
    ['No Z-reading data found for this date.'],
    ['Please ensure the mobile app has generated and synced a Z-reading for this date.'],
  ];
}

// Generate X Reading CSV from Firebase pre-calculated readings
export async function generateXCsv(startDate: string, endDate?: string): Promise<string[][]> {
  const userUid = getCurrentUserUid();
  if (!userUid) {
    return [['Error: User not authenticated. Please log in to generate reports.']];
  }

  const sttS = Moment(startDate, 'YYMMDD').startOf('day').format('X');
  const endS = Moment(endDate || startDate, 'YYMMDD').endOf('day').format('X');

  try {
    const journalRef = ref(database, `${userUid}/journal`);
    const journalQuery = query(journalRef, orderByKey(), startAt(sttS), endAt(endS));
    const snapshot = await get(journalQuery);

    const xTexts: string[] = [];
    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const val = child.val();
        if (val?.xReading) xTexts.push(val.xReading);
      });
    }

    const horizontal = readingTextsToHorizontal(xTexts);
    if (horizontal.length) return horizontal;
  } catch (firebaseError) {
    console.warn('Error fetching X reading from Firebase:', firebaseError);
  }

  return [
    ['X-READING REPORT'],
    ['Period', `${startDate}${endDate ? ` to ${endDate}` : ''}`],
    [],
    ['No X-reading data found for this period.'],
    ['Please ensure the mobile app has generated and synced an X-reading for this period.'],
  ];
}

// Web utility to get current user settings (placeholder)
export async function getUserSettings() {
  const userUid = getCurrentUserUid();
  if (!userUid) {
    console.warn('User not authenticated');
    return {
      name: '',
      address: '',
      receiptDetails: {
        VATTIN: '',
        NONVATTIN: '',
        SN: '',
        MIN: '',
        permitNo: '',
        receiptType: 'OR'
      }
    };
  }

  try {
    const settingsRef = ref(database, `${userUid}/settings`);
    const snapshot = await get(settingsRef);
    if (snapshot.exists()) {
      const data = snapshot.val();
      return {
        name: data.name || '',
        address: data.address || '',
        businessStyle: data.businessStyle || '',
        ownerName: data.ownerName || '',
        receiptDetails: {
          VATTIN: data.receiptDetails?.VATTIN || '',
          NONVATTIN: data.receiptDetails?.NONVATTIN || '',
          SN: data.receiptDetails?.SN || '',
          MIN: data.receiptDetails?.MIN || '',
          permitNo: data.receiptDetails?.permitNo || '',
          receiptType: data.receiptDetails?.receiptType || 'OR',
          BIR: data.receiptDetails?.BIR ?? false,
        },
        miniprinter: data.miniprinter ?? false,
        BIRStartDate: data.BIRStartDate || '',
        BIRresetNo: data.BIRresetNo || 0,
        zReadNo: data.zReadNo || 1,
        accumulatedSalesResetAt: data.accumulatedSalesResetAt || '0',
        accumulatedSalesCarryover: Number(data.accumulatedSalesCarryover) || 0,
        posTerminalNumber: data.posTerminalNumber || '1',
        account: data.account || '',
        servicePercentage: data.servicePercentage || 0,
        lastEndOfDay: data.lastEndOfDay || 0
      };
    }
    return {
      name: '',
      address: '',
      receiptDetails: {
        VATTIN: '',
        NONVATTIN: '',
        SN: '',
        MIN: '',
        permitNo: '',
        receiptType: 'OR'
      }
    };
  } catch (error) {
    console.error('Error fetching user settings:', error);
    return {
      name: '',
      address: '',
      receiptDetails: {
        VATTIN: '',
        NONVATTIN: '',
        SN: '',
        MIN: '',
        permitNo: '',
        receiptType: 'OR'
      }
    };
  }
}

// Format time range for filenames
export function formatTimeRange(startTimestamp: number, endTimestamp: number): { start: string; end: string } {
  return {
    start: Moment.unix(startTimestamp).format('MM-DD ha'),
    end: Moment.unix(endTimestamp).format('MM-DD ha')
  };
}

export default {
  downloadCsvFile,
  downloadExcelFile,
  generateTransactionsCsv,
  generateRefundsCsv,
  generateZCsv,
  generateXCsv,
  getUserSettings,
  formatTimeRange
};