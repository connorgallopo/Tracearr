import type { NewsletterSendTrigger } from '@tracearr/shared';

export interface RunResult {
  outcome: 'queued' | 'resumed' | 'skipped_empty' | 'failed' | 'busy';
  sendId: string | null;
  queuedRecipientIds: string[];
}

export async function runNewsletter(
  _newsletterId: string,
  _trigger: NewsletterSendTrigger,
  _testAddress?: string
): Promise<RunResult> {
  throw new Error('not implemented');
}
