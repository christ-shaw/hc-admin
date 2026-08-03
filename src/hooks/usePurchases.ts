import { useCallback, useState } from 'react';
import { callFunction } from '../lib/cloudbase';

export interface PaymentVoucher {
  fileID: string;
  fileName: string;
}

export interface PurchasePayment {
  amount: number;
  date: string;
  account: string;
  splits: PurchasePaymentSplit[];
  remark: string;
  vouchers: PaymentVoucher[];
  confirmedBy: string;
  confirmedByName: string;
  confirmedAt: string;
}

export interface PurchasePaymentSplit {
  account: string;
  amount: number;
}

export interface PurchaseOperation {
  action: 'created' | 'updated' | 'payment_confirmed' | string;
  content: string;
  operatedAt: string;
  operatorId: string;
  operatorName: string;
}

export interface PurchaseAdjustment {
  id: string;
  type: 'supplier_return';
  quantity: number;
  reason: string;
  remark: string;
  operatedAt: string;
  operatorId: string;
  operatorName: string;
}

export type PurchaseType = 'purchase' | 'recycle';

export interface PurchaseRecord {
  _id: string;
  purchaseNumber: string;
  date: string;
  purchaseType: PurchaseType;
  brand: string;
  model: string;
  specification: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  supplier: string;
  supplierId?: string;
  owner: string;
  paymentStatus: 'pending' | 'paid' | 'no_payment';
  payment?: PurchasePayment | null;
  operations?: PurchaseOperation[];
  adjustments?: PurchaseAdjustment[];
  returnedQuantity: number;
  payableQuantity: number;
  returnDeduction: number;
  payableAmount: number;
  createdAt?: string;
  updatedAt?: string;
}

export type PurchaseCreateInput = Pick<PurchaseRecord,
  'date' | 'purchaseType' | 'brand' | 'model' | 'specification' | 'quantity' | 'unitPrice' | 'supplier' | 'supplierId' | 'owner'
> & { operatorName?: string };

export type PurchaseUpdateInput = PurchaseCreateInput;

export interface ConfirmPaymentInput {
  paymentDate: string;
  paymentAccount: string;
  paymentAmount: number;
  paymentSplits: PurchasePaymentSplit[];
  remark: string;
  vouchers: PaymentVoucher[];
  confirmedByName: string;
}

interface PurchaseResult<T = unknown> {
  success: boolean;
  data?: T;
  errMsg?: string;
}

export function usePurchases() {
  const [records, setRecords] = useState<PurchaseRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const fetchPurchases = useCallback(async () => {
    setLoading(true);
    setErrorMessage('');
    try {
      const result = await callFunction<PurchaseResult<PurchaseRecord[]>>('managePurchases', { action: 'list' });
      if (!result.success) {
        setRecords([]);
        setErrorMessage(result.errMsg || '加载采购单失败');
        return [];
      }
      const data = result.data || [];
      setRecords(data);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载采购单失败';
      setRecords([]);
      setErrorMessage(message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const createPurchase = useCallback(async (purchase: PurchaseCreateInput) => {
    try {
      const result = await callFunction<PurchaseResult<PurchaseRecord>>('managePurchases', {
        action: 'create',
        purchase,
      });
      if (result.success && result.data) setRecords(prev => [result.data!, ...prev]);
      return result;
    } catch (error) {
      return { success: false, errMsg: String(error) } as PurchaseResult<PurchaseRecord>;
    }
  }, []);

  const updatePurchase = useCallback(async (purchaseId: string, purchase: PurchaseUpdateInput) => {
    try {
      const result = await callFunction<PurchaseResult<PurchaseRecord>>('managePurchases', {
        action: 'update',
        purchaseId,
        purchase,
      });
      if (result.success && result.data) {
        setRecords(prev => prev.map(item => item._id === purchaseId ? result.data! : item));
      }
      return result;
    } catch (error) {
      return { success: false, errMsg: String(error) } as PurchaseResult<PurchaseRecord>;
    }
  }, []);

  const deletePurchase = useCallback(async (purchaseId: string) => {
    try {
      const result = await callFunction<PurchaseResult>('managePurchases', { action: 'delete', purchaseId });
      if (result.success) setRecords(prev => prev.filter(item => item._id !== purchaseId));
      return result;
    } catch (error) {
      return { success: false, errMsg: String(error) } as PurchaseResult;
    }
  }, []);

  const returnToSupplier = useCallback(async (purchaseId: string, quantity: number, reason: string, remark: string, operatorName: string) => {
    try {
      const result = await callFunction<PurchaseResult<PurchaseRecord>>('managePurchases', {
        action: 'returnToSupplier',
        purchaseId,
        quantity,
        reason,
        remark,
        operatorName,
      });
      if (result.success && result.data) {
        setRecords(prev => prev.map(item => item._id === purchaseId ? result.data! : item));
      }
      return result;
    } catch (error) {
      return { success: false, errMsg: String(error) } as PurchaseResult<PurchaseRecord>;
    }
  }, []);

  const confirmPayment = useCallback(async (purchaseId: string, payment: ConfirmPaymentInput) => {
    try {
      const result = await callFunction<PurchaseResult<PurchaseRecord>>('managePurchases', {
        action: 'confirmPayment',
        purchaseId,
        ...payment,
      });
      if (result.success && result.data) {
        setRecords(prev => prev.map(item => item._id === purchaseId ? result.data! : item));
      }
      return result;
    } catch (error) {
      return { success: false, errMsg: String(error) } as PurchaseResult<PurchaseRecord>;
    }
  }, []);

  return {
    records,
    loading,
    errorMessage,
    fetchPurchases,
    createPurchase,
    updatePurchase,
    returnToSupplier,
    deletePurchase,
    confirmPayment,
  };
}
