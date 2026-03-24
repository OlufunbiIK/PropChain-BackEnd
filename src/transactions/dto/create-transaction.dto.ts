export class CreateTransactionDto {
  fromAddress: string;
  toAddress: string;
  amount: number;
  type: string;
  buyerId: string;
  sellerId: string;
  currency: string;
  propertyId?: string;
  txHash?: string;
}

export class PaginationParams {
  page?: number;
  limit?: number;
}

export class DisputeDto {
  reason: string;
  details?: string;
}
