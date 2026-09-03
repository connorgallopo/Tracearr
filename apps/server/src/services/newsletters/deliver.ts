export interface DeliveryJob {
  sendId: string;
  recipientId: string;
}

export async function deliverRecipient(_job: DeliveryJob): Promise<void> {
  throw new Error('not implemented');
}

export async function markRecipientFailed(_recipientId: string, _error: unknown): Promise<void> {
  throw new Error('not implemented');
}
