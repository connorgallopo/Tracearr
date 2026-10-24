import { z } from 'zod';
import { uuidSchema } from '../schemas.js';
import { createAutomationSchema } from './definition.js';
import type { ConditionEvidence } from './definition.js';
import type { TriggerType } from './triggers.js';

export const dryRunRequestSchema = z.object({
  definition: createAutomationSchema,
  /**
   * One session to check instead of the live set; a run's session id, when it had one, and its
   * start when known, which bounds the read.
   */
  sample: z.object({ sessionId: uuidSchema, startedAt: z.coerce.date().optional() }).optional(),
});
export type DryRunRequest = z.infer<typeof dryRunRequestSchema>;

/** The session a sample was evaluated against, named for display. */
export interface DryRunSubject {
  sessionId: string;
  user: { id: string; name: string };
  server: { id: string; name: string };
}

export interface DryRunCondition {
  nodeId: string;
  passed: boolean;
  evidence: ConditionEvidence;
}

export interface DryRunAction {
  nodeId: string;
  wouldRun: boolean;
  /** Why the node stays put: disabled, conditions unmet, or a branch not taken. */
  reason?: string;
  /** `if` nodes only: the branch its conditions pick against this subject. */
  branch?: 'then' | 'else';
}

export interface DryRunSample {
  subject: DryRunSubject;
  /** The enabled session triggers that would reach this subject. */
  triggers: TriggerType[];
  conditions: DryRunCondition[];
  actions: DryRunAction[];
  wouldRun: boolean;
  summary: string;
}

export interface DryRunResponse {
  samples: DryRunSample[];
}
