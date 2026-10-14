// TypeScript port of mobile TransactionItem.js — keep in sync with utakmobileBIR

import { roundMoney, calcPaxDiscount, PaxDiscountResult, PaxPart } from '../utils/bir/money';

export const DISCOUNT_TYPES = [
  'regular', 'senior', 'pwd', 'ntlAthlete', 'diplomat', 'soloParent', 'medalOfValor',
  'commodity', 'promotional',
] as const;
export type DiscountType = typeof DISCOUNT_TYPES[number];

export interface TransactionItemValue {
  quantity?: number | string;
  price?: number | string;
  costPrice?: number | string;
  service?: number | string;
  discount?: number | string;
  discountSubtotal?: number | string;
  individualDiscountType?: string;
  transactionDiscountType?: string;
  zeroVAT?: boolean;
  _defaultVatType?: string;
  refunded?: boolean;
  paxDiscount?: Record<string, PaxDiscountEntry>;
  isCommodity?: boolean;
  [key: string]: any;
}

export interface PaxDiscountEntry {
  guestCount: number;
  percent?: string | number;
}

/** Per-guest part of a PAX-discounted item. Shape owned by calcPaxDiscount. */
export type PartResult = PaxPart;

/** Aggregated PAX parts for an item. Shape owned by calcPaxDiscount. */
export type BuildPartsResult = PaxDiscountResult;

class TransactionItem {
  static readonly SENIOR_AND_PWD_DISCOUNT_RATE_WITH_VAT_EXEMPTION_RATE_FROM_DB = 28.5714285;
  static readonly MONEY_PRECISION = 100;
  static readonly DISCOUNT_TYPES: readonly string[] = DISCOUNT_TYPES;

  static readonly defaultOpts = {
    vatRate: 0.12,
    specialDiscountRates: {
      senior: 0.2,
      pwd: 0.2,
      diplomat: 0,
      ntlAthlete: 0.2,
      soloParent: 0.1,
      medalOfValor: 0.2,
      commodity: 0.05,
      promotional: 0,
    } as Record<string, number>,
  };

  static numberOrZero(n: any): number {
    return parseFloat(n) || 0;
  }

  static moneyOrZero(n: any): number {
    return TransactionItem.MONEY_PRECISION * TransactionItem.numberOrZero(n);
  }

  static round(n: any): number {
    const num = TransactionItem.numberOrZero(n);
    const out = Math.round(Math.abs(num));
    return num < 0 ? -1 * out : out;
  }

  static discountRateWithVatExemption(rate: number, vatRate = 0.12): number {
    const discRate = TransactionItem.numberOrZero(rate);
    const vat = TransactionItem.numberOrZero(vatRate);
    if (!discRate && !vat) return 0;
    return ((discRate + vat) / (1 + vat)) * 100;
  }

  static normalizeSpecialDiscountRate(rate: number, defaultRate: number, vatRate = 0.12): number {
    const canonical = typeof defaultRate === 'number' ? defaultRate : 0;
    const parsed = TransactionItem.numberOrZero(rate);
    const expectedDbRate = TransactionItem.discountRateWithVatExemption(canonical, vatRate);

    const matchesCanonical =
      Math.abs(parsed - expectedDbRate) < 0.05 ||
      Math.abs(parsed - canonical * 100) < 0.05;
    if (matchesCanonical) return canonical;

    const normalized = parsed >= 1 ? (parsed / 100) * (1 + vatRate) - vatRate : parsed;
    if (!Number.isFinite(normalized)) return canonical;
    if (Math.abs(normalized - canonical) > 0.05) return canonical;
    return normalized;
  }

  static inferDiscountType(type: string): DiscountType {
    return TransactionItem.DISCOUNT_TYPES.includes(type) ? (type as DiscountType) : 'regular';
  }

  key: number | string | null;
  original: TransactionItemValue;
  _opts: typeof TransactionItem.defaultOpts;
  vatRate: number;
  quantity: number;
  price: number;
  cost: number;
  svcRate: number;
  refunded: boolean | undefined;
  _defaultVatType: string | undefined;
  _itmDiscType!: DiscountType;
  _itmDiscRate!: number;
  _txnDiscType!: DiscountType;
  _txnDiscRate!: number;
  _parts: BuildPartsResult | null;

  constructor({ val, key = null, ...opts }: { val: TransactionItemValue; key?: number | string | null; [k: string]: any }) {
    this.key = key;
    this.original = JSON.parse(JSON.stringify(val));
    this._opts = { ...TransactionItem.defaultOpts, ...(opts as any) };
    this.vatRate = this._opts.vatRate;
    this.quantity = TransactionItem.numberOrZero(val.quantity) || 1;
    this.price = TransactionItem.moneyOrZero(val.price);
    this.cost = TransactionItem.moneyOrZero(val.costPrice);
    this.svcRate = TransactionItem.numberOrZero(val.service) / 100;
    this.refunded = val.refunded;
    this._defaultVatType = val._defaultVatType;
    this._inferDiscount('itm', val.individualDiscountType, val.discount);
    this._inferDiscount('txn', val.transactionDiscountType, val.discountSubtotal);
    this._parts = buildParts({ val }, this.vatRate, this.svcRate);
  }

  get _fix_multipleVatRemovals(): boolean {
    return !!this._defaultVatType;
  }

  get defaultVatType(): string {
    if (this._defaultVatType) return this._defaultVatType;
    if (this.original.zeroVAT) return 'vatExempt';
    return 'vatable';
  }

  get itmDiscType(): DiscountType { return this._itmDiscType; }
  get itmDiscRate(): number { return this._itmDiscRate; }
  get itmDiscRateForDisplay(): number { return this._effectiveItmDiscRate; }

  setItmDiscount = (type: DiscountType, rate: number) => this._setDiscount('itm', type, rate);

  get txnDiscType(): DiscountType { return this._txnDiscType; }
  get txnDiscRate(): number { return this._txnDiscRate; }
  get txnDiscRateForDisplay(): number { return this._effectiveTxnDiscRate; }

  setTxnDiscount = (type: DiscountType, rate: number) => this._setDiscount('txn', type, rate);

  _setDiscount(location: 'itm' | 'txn', type: string, rate?: number) {
    if (!['itm', 'txn'].includes(location)) return;
    if (!TransactionItem.DISCOUNT_TYPES.includes(type)) return;
    (this as any)[`_${location}DiscType`] = type as DiscountType;
    (this as any)[`_${location}DiscRate`] =
      typeof rate === 'undefined'
        ? this._opts.specialDiscountRates[type] || 0
        : TransactionItem.numberOrZero(rate);
  }

  _inferDiscount(location: 'itm' | 'txn', _type?: string, _rate?: any) {
    if (!['itm', 'txn'].includes(location)) return;
    if (this.original.paxDiscount) {
      (this as any)[`_${location}DiscType`] = 'regular';
      (this as any)[`_${location}DiscRate`] = 0;
      return;
    }

    const parsedRate = TransactionItem.numberOrZero(_rate);
    const specialDbRate = (rate: number) => TransactionItem.discountRateWithVatExemption(rate, this.vatRate);
    const snrPwdLike =
      Math.abs(parsedRate - TransactionItem.SENIOR_AND_PWD_DISCOUNT_RATE_WITH_VAT_EXEMPTION_RATE_FROM_DB) < 0.01;
    const commodityDbRate = specialDbRate(this._opts.specialDiscountRates.commodity);
    const commodityLike = Math.abs(parsedRate - commodityDbRate) < 0.01 || Math.abs(parsedRate - 5) < 0.01;
    const soloParentLike =
      Math.abs(parsedRate - specialDbRate(this._opts.specialDiscountRates.soloParent)) < 0.01;

    const type: DiscountType = TransactionItem.DISCOUNT_TYPES.includes(_type as string)
      ? (_type as DiscountType)
      : snrPwdLike
      ? 'senior'
      : soloParentLike
      ? 'soloParent'
      : _type === 'senior'
      ? 'senior'
      : 'regular';

    const isCommodity = this.original.isCommodity === true;
    const commodityDiscountTypes = ['senior', 'pwd', 'medalOfValor'];
    const isCommodityDiscount = isCommodity && commodityDiscountTypes.includes(type);

    let defaultRate = this._opts.specialDiscountRates[type];
    if (isCommodityDiscount) defaultRate = this._opts.specialDiscountRates.commodity;
    if (commodityDiscountTypes.includes(type) && commodityLike) defaultRate = this._opts.specialDiscountRates.commodity;

    let rate: number;
    if (type === 'regular') {
      rate = TransactionItem.numberOrZero(_rate) / 100;
    } else if (type === 'promotional') {
      rate = TransactionItem.numberOrZero(_rate) / 100;
    } else if (isCommodityDiscount) {
      rate = defaultRate;
      // UTAK Retail: the weekly BNPC cap can leave only part of a line
      // eligible; the line then carries its effective rate (never above the
      // 5%). F&B lines never set bnpcRate. Mirrors the device model.
      const bnpcRate = Number((this.original as any).bnpcRate);
      if ((this.original as any).bnpcRate != null && Number.isFinite(bnpcRate)) {
        rate = Math.max(0, Math.min(bnpcRate, defaultRate));
      }
    } else {
      rate = TransactionItem.normalizeSpecialDiscountRate(parsedRate, defaultRate, this.vatRate);
    }
    this._setDiscount(location, type, rate);
  }

  get $price(): number {
    return this.defaultVatType === 'vatable' ? this.price / (1 + this.vatRate) : this.price;
  }

  get $baseSales(): number {
    return this.quantity * this.price;
  }

  get $grossSales(): number {
    return this.defaultVatType === 'vatable'
      ? this.$baseSales / (1 + this.vatRate)
      : this.$baseSales;
  }

  get $grossVat(): number {
    return this.$grossSales * this.vatRate;
  }

  get $itmDiscount(): number {
    if (this.__itmDiscGrossBased) {
      if (this.itmDiscRate >= 1) return this.$baseSales;
      return this.$baseSales * this.itmDiscRate;
    }
    return this.$grossSales * this.itmDiscRate;
  }

  get $txnDiscount(): number {
    if (this.__txnDiscGrossBased) {
      if (this.txnDiscRate >= 1) return this.$baseSales;
      return this.$baseSales * this.txnDiscRate;
    }
    return this.$grossSales * this.txnDiscRate;
  }

  get $discount(): number {
    const total = this.$itmDiscount + this.$txnDiscount;
    const hasRegular =
      (this.__itmDiscGrossBased && this.itmDiscRate > 0) ||
      (this.__txnDiscGrossBased && this.txnDiscRate > 0);
    if (this.vatType === 'vatable' && hasRegular && (this.itmDiscRate >= 1 || this.txnDiscRate >= 1)) {
      return Math.min(total, this.$baseSales);
    }
    return total;
  }

  get $service(): number {
    if (this._parts) return this._parts.service;
    const isNaac =
      this.vatType === 'vatable' &&
      (this.itmDiscType === 'ntlAthlete' || this.txnDiscType === 'ntlAthlete');
    if (isNaac) {
      return (this.$grossSales - this.$discount) * this.svcRate;
    }
    return this.$netSales * this.svcRate;
  }

  get $subtotal(): number {
    return this.$grossSales - this.$itmDiscount;
  }

  get $netSales(): number {
    const hasRegular =
      (this.__itmDiscGrossBased && this.itmDiscRate > 0) ||
      (this.__txnDiscGrossBased && this.txnDiscRate > 0);
    if (this.vatType === 'vatable' && hasRegular) {
      const cap = this.$baseSales >= 0 ? this.$baseSales : -this.$baseSales;
      const discountToSubtract = Math.min(this.$discount, cap);
      return (this.$baseSales - discountToSubtract) / (1 + this.vatRate);
    }
    const cap = this.$grossSales >= 0 ? this.$grossSales : -this.$grossSales;
    const discountToSubtract = Math.min(this.$discount, cap);
    return this.$grossSales - discountToSubtract;
  }

  get $total(): number {
    return this.$netSales;
  }

  get $vat(): number {
    if (this._parts) return this._parts.vat;
    if (this.vatType !== 'vatable') return 0;
    const hasRegular =
      (this.__itmDiscGrossBased && this.itmDiscRate > 0) ||
      (this.__txnDiscGrossBased && this.txnDiscRate > 0);
    const isNaac = this.itmDiscType === 'ntlAthlete' || this.txnDiscType === 'ntlAthlete';
    if (isNaac) {
      return this.$grossSales * this.vatRate;
    }
    if (hasRegular || this.itmDiscRate >= 1 || this.txnDiscRate >= 1) {
      return this.$netSales * this.vatRate;
    }
    return this.$grossSales * this.vatRate;
  }

  get $vatExemption(): number {
    if (this._parts) return this._parts.vatExemption;
    return 0;
  }

  get $amountDue(): number {
    if (this._parts) return this._parts.total;
    const isNaac =
      this.vatType === 'vatable' &&
      (this.itmDiscType === 'ntlAthlete' || this.txnDiscType === 'ntlAthlete');
    if (isNaac) {
      return this.$baseSales - this.$discount + this.$service;
    }
    return this.$netSales + this.$service + this.$vat;
  }

  get $vatableSales(): number {
    if (this._parts?.values) {
      return Object.values(this._parts.values).reduce((sum, part) => {
        if (part.vatType !== 'vatable') return sum;
        return sum + (part.discType === 'ntl' ? part.grossSales : part.netSales);
      }, 0);
    }
    if (this.vatType !== 'vatable') return 0;
    const vatableDiscounts = ['ntlAthlete'];
    if (vatableDiscounts.includes(this.itmDiscType) || vatableDiscounts.includes(this.txnDiscType)) {
      return this.$grossSales;
    }
    return this.$netSales;
  }

  get $vatExemptSales(): number {
    if (this._parts?.values) {
      return Object.values(this._parts.values).reduce((sum, part) => {
        return sum + (part.vatType === 'vatExempt' ? part.grossSales : 0);
      }, 0);
    }
    return this.vatType === 'vatExempt' ? this.$grossSales : 0;
  }

  get $zeroRatedSales(): number {
    if (this._parts?.values) {
      return Object.values(this._parts.values).reduce((sum, part) => {
        if (part.vatType !== 'zeroVat') return sum;
        return sum + part.grossSales * (1 + this.vatRate);
      }, 0);
    }
    return this.vatType === 'zeroVat' ? this.$baseSales : 0;
  }

  get vatType(): string {
    const isCommodity = this.original.isCommodity === true;
    const commodityDiscountTypes = ['senior', 'pwd', 'medalOfValor'];
    const hasCommodityDiscount =
      isCommodity &&
      (commodityDiscountTypes.includes(this.itmDiscType) || commodityDiscountTypes.includes(this.txnDiscType));
    if (hasCommodityDiscount) return this.defaultVatType;

    const zeroRatedDiscounts = ['diplomat'];
    if (zeroRatedDiscounts.includes(this.itmDiscType) || zeroRatedDiscounts.includes(this.txnDiscType)) {
      return 'zeroVat';
    }

    const vatableDiscounts = ['ntlAthlete'];
    if (vatableDiscounts.includes(this.itmDiscType) || vatableDiscounts.includes(this.txnDiscType)) {
      return this.defaultVatType;
    }

    const isPlainVatable = (t: string) => t === 'regular' || t === 'promotional';
    return !isPlainVatable(this.itmDiscType) || !isPlainVatable(this.txnDiscType)
      ? 'vatExempt'
      : this.original.zeroVAT
      ? 'vatExempt'
      : this.defaultVatType;
  }

  get __willRemoveItmVat(): boolean {
    const isCommodity = this.original.isCommodity === true;
    const commodityDiscountTypes = ['senior', 'pwd', 'medalOfValor'];
    if (isCommodity && commodityDiscountTypes.includes(this.itmDiscType)) return false;
    if (['diplomat'].includes(this.itmDiscType)) return false;
    if (['ntlAthlete'].includes(this.itmDiscType)) return false;
    const isPlainVatable = (t: string) => t === 'regular' || t === 'promotional';
    if (this._fix_multipleVatRemovals) {
      return (
        !this.original.zeroVAT &&
        this.defaultVatType === 'vatable' &&
        !isPlainVatable(this.itmDiscType)
      );
    }
    return !isPlainVatable(this.itmDiscType);
  }

  get __discountBase(): number {
    return this.defaultVatType === 'vatable'
      ? (this.quantity * this.price) / (1 + this.vatRate)
      : this.quantity * this.price;
  }

  get __itmVatExemption(): number {
    if (!this.__willRemoveItmVat) return 0;
    return TransactionItem.round(((this.quantity * this.price) / (1 + this.vatRate)) * this.vatRate);
  }

  /**
   * SC/PWD/MOV on a basic necessity / prime commodity: 5% of the regular
   * retail price, VAT not exempted (DA-DTI-DOE JAO, March 2024). Computed
   * like a regular discount (on the VAT-inclusive price, VAT kept); the type
   * stays senior/pwd/medalOfValor so reports file it under SC/PWD/MOV.
   * Mirrors the device fix (utakretailBIR 0e3d8046, 4d4b5fca): the special
   * path normalised the 5% back to 20% on the VAT-exclusive base, so a P500
   * commodity line got P89.29 off instead of P25.00.
   */
  get __isCommodityDiscount(): boolean {
    return this.original.isCommodity === true && ['senior', 'pwd', 'medalOfValor'].includes(this.itmDiscType);
  }

  get __itmDiscGrossBased(): boolean {
    return this.itmDiscType === 'regular' || this.itmDiscType === 'promotional' || this.__isCommodityDiscount;
  }

  get __txnDiscGrossBased(): boolean {
    return (
      this.txnDiscType === 'regular' ||
      this.txnDiscType === 'promotional' ||
      (this.original.isCommodity === true && ['senior', 'pwd', 'medalOfValor'].includes(this.txnDiscType))
    );
  }

  get _effectiveItmDiscRate(): number {
    if (this.__isCommodityDiscount) return this.itmDiscRate;
    const specialTypes = ['senior', 'pwd', 'ntlAthlete', 'diplomat', 'soloParent', 'medalOfValor', 'commodity'];
    if (!specialTypes.includes(this.itmDiscType) || this.defaultVatType !== 'vatable') return this.itmDiscRate;
    const defaultRate = this._opts.specialDiscountRates[this.itmDiscType] ?? 0.2;
    return TransactionItem.normalizeSpecialDiscountRate(this.itmDiscRate * 100, defaultRate, this.vatRate);
  }

  get itmDiscount(): number {
    if (this.__itmDiscGrossBased) {
      if (this.itmDiscRate >= 1) return TransactionItem.round(this.$baseSales);
      return TransactionItem.round(this.$baseSales * this.itmDiscRate);
    }
    if (this.defaultVatType === 'vatable') {
      return TransactionItem.round(this.__discountBase * this._effectiveItmDiscRate);
    }
    const itmVatExemptRate = this.__willRemoveItmVat ? this.vatRate : 0;
    return TransactionItem.round(
      ((this.quantity * this.price) / (1 + itmVatExemptRate)) * this.itmDiscRate
    );
  }

  get __itmEffDisc(): number {
    return this.__itmVatExemption + this.itmDiscount;
  }

  get __itmTotal(): number {
    return this.quantity * this.price - this.__itmVatExemption - this.itmDiscount;
  }

  get __willRemoveTxnVat(): boolean {
    const isCommodity = this.original.isCommodity === true;
    const commodityDiscountTypes = ['senior', 'pwd', 'medalOfValor'];
    if (isCommodity && commodityDiscountTypes.includes(this.txnDiscType)) return false;
    if (['diplomat'].includes(this.txnDiscType)) return false;
    if (['ntlAthlete'].includes(this.txnDiscType)) return false;
    const isPlainVatable = (t: string) => t === 'regular' || t === 'promotional';
    if (this._fix_multipleVatRemovals) {
      return (
        !this.original.zeroVAT &&
        this.defaultVatType === 'vatable' &&
        !this.__willRemoveItmVat &&
        !isPlainVatable(this.txnDiscType)
      );
    }
    return !isPlainVatable(this.txnDiscType);
  }

  get __txnVatExemption(): number {
    if (!this.__willRemoveTxnVat) return 0;
    return (this.__itmTotal / (1 + this.vatRate)) * this.vatRate;
  }

  get vatExemption(): number {
    if (this._parts) return this._parts.vatExemption;
    return this.__itmVatExemption + this.__txnVatExemption;
  }

  get _effectiveTxnDiscRate(): number {
    if (this.original.isCommodity === true && ['senior', 'pwd', 'medalOfValor'].includes(this.txnDiscType)) {
      return this.txnDiscRate;
    }
    const specialTypes = ['senior', 'pwd', 'ntlAthlete', 'diplomat', 'soloParent', 'medalOfValor', 'commodity'];
    if (!specialTypes.includes(this.txnDiscType) || this.defaultVatType !== 'vatable') return this.txnDiscRate;
    const defaultRate = this._opts.specialDiscountRates[this.txnDiscType] ?? 0.2;
    return TransactionItem.normalizeSpecialDiscountRate(this.txnDiscRate * 100, defaultRate, this.vatRate);
  }

  get txnDiscount(): number {
    if (this.__txnDiscGrossBased) {
      if (this.txnDiscRate >= 1) return TransactionItem.round(this.$baseSales);
      return TransactionItem.round(this.$baseSales * this.txnDiscRate);
    }
    return TransactionItem.round(this.__discountBase * this._effectiveTxnDiscRate);
  }

  get discount(): number {
    if (this._parts) return this._parts.discount;
    const total = this.itmDiscount + this.txnDiscount;
    const hasRegular =
      (this.__itmDiscGrossBased && this.itmDiscRate > 0) ||
      (this.__txnDiscGrossBased && this.txnDiscRate > 0);
    if (this.defaultVatType === 'vatable' && hasRegular && (this.itmDiscRate >= 1 || this.txnDiscRate >= 1)) {
      return TransactionItem.round(Math.min(total, this.$baseSales));
    }
    return total;
  }

  get service(): number {
    if (this._parts) return this._parts.service;
    const isNaac =
      this.vatType === 'vatable' &&
      (this.itmDiscType === 'ntlAthlete' || this.txnDiscType === 'ntlAthlete');
    if (isNaac) {
      return roundMoney((this.$grossSales - this.$discount) * this.svcRate);
    }
    return this.__itmTotal * this.svcRate;
  }

  get total(): number {
    if (this._parts) return this._parts.total;
    return this.quantity * this.price - this.vatExemption - this.discount + this.service;
  }

  get netSales(): number {
    if (this._parts) return this._parts.netSales;
    return this.total - this.service;
  }

  get grossSales(): number {
    if (this._parts) return this._parts.grossSales;
    return this.netSales + this.discount;
  }

  get vat(): number {
    if (this._parts) return this._parts.vat;
    if (this.vatType !== 'vatable') return 0;
    const hasRegular =
      (this.__itmDiscGrossBased && this.itmDiscRate > 0) ||
      (this.__txnDiscGrossBased && this.txnDiscRate > 0);
    const vatableDiscounts = ['ntlAthlete'];
    if (vatableDiscounts.includes(this.itmDiscType) || vatableDiscounts.includes(this.txnDiscType)) {
      return TransactionItem.round(this.$grossSales * this.vatRate);
    }
    if (hasRegular || this.itmDiscRate >= 1 || this.txnDiscRate >= 1) {
      return TransactionItem.round(this.$netSales * this.vatRate);
    }
    return TransactionItem.round(this.$grossSales * this.vatRate);
  }

  get totalCost(): number {
    return this.quantity * this.cost;
  }

  get isRefunded(): boolean | undefined {
    return this.refunded;
  }
}

export default TransactionItem;

function buildParts(
  { val }: { val: TransactionItemValue },
  vatRate: number,
  svcRate: number,
): BuildPartsResult | null {
  if (!val.paxDiscount) return null;
  return calcPaxDiscount(val, { vatRate, svcRate });
}
