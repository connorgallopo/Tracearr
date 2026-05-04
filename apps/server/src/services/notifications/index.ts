/**
 * Notification Manager
 *
 * Central orchestrator for all notification agents.
 * Provides a unified interface for sending notifications through all enabled channels.
 */

import type {
  NotificationAgent,
  NotificationPayload,
  NotificationSettings,
  SendResult,
  TestResult,
  ViolationWithDetails,
  ActiveSession,
  Server,
  ServerUser,
} from './types.js';
import { PayloadBuilders } from './types.js';
import { createAllAgents } from './agents/index.js';

// Re-export types and utilities
export type {
  NotificationAgent,
  NotificationPayload,
  NotificationSettings,
  NotificationEventType,
  SendResult,
  TestResult,
  NotificationSeverity,
  ViolationContext,
  SessionContext,
  ServerContext,
  NewDeviceContext,
  TrustScoreChangedContext,
  NotificationContext,
} from './types.js';
export { PayloadBuilders } from './types.js';
export * from './agents/index.js';

/**
 * Central notification manager that orchestrates all agents.
 */
export class NotificationManager {
  private agents: NotificationAgent[];

  constructor(agents?: NotificationAgent[]) {
    this.agents = agents ?? createAllAgents();
  }

  /**
   * Register a new notification agent
   */
  registerAgent(agent: NotificationAgent): void {
    // Avoid duplicates
    if (!this.agents.find((a) => a.name === agent.name)) {
      this.agents.push(agent);
    }
  }

  /**
   * Get all registered agents
   */
  getAgents(): NotificationAgent[] {
    return [...this.agents];
  }

  /**
   * Get an agent by name
   */
  getAgent(name: string): NotificationAgent | undefined {
    return this.agents.find((agent) => agent.name === name);
  }

  /**
   * Send notification to all enabled agents for the given event.
   * Returns results from all agents (success and failures).
   */
  async sendAll(
    payload: NotificationPayload,
    settings: NotificationSettings
  ): Promise<SendResult[]> {
    const enabledAgents = this.agents.filter((agent) => agent.shouldSend(payload.event, settings));

    if (enabledAgents.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      enabledAgents.map((agent) => agent.send(payload, settings))
    );

    return results.map((result, index) => {
      const agent = enabledAgents[index];
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        success: false,
        error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
        agent: agent?.name ?? 'unknown',
      };
    });
  }

  /**
   * Test a specific agent by name
   */
  async testAgent(agentName: string, settings: NotificationSettings): Promise<TestResult> {
    const agent = this.getAgent(agentName);
    if (!agent) {
      return { success: false, error: `Agent '${agentName}' not found` };
    }
    return agent.sendTest(settings);
  }

  // Convenience methods for common notification types

  /**
   * Send a violation notification to all enabled agents
   */
  async notifyViolation(
    violation: ViolationWithDetails,
    settings: NotificationSettings
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromViolation(violation);
    return this.sendAll(payload, settings);
  }

  /**
   * Send a session started notification to all enabled agents
   */
  async notifySessionStarted(
    session: ActiveSession,
    settings: NotificationSettings
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromSessionStarted(session);
    return this.sendAll(payload, settings);
  }

  /**
   * Send a session stopped notification to all enabled agents
   */
  async notifySessionStopped(
    session: ActiveSession,
    settings: NotificationSettings
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromSessionStopped(session);
    return this.sendAll(payload, settings);
  }

  /**
   * Send a server down notification to all enabled agents
   */
  async notifyServerDown(
    serverName: string,
    settings: NotificationSettings,
    serverType?: 'plex' | 'jellyfin' | 'emby'
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromServerDown(serverName, serverType);
    return this.sendAll(payload, settings);
  }

  /**
   * Send a server up notification to all enabled agents
   */
  async notifyServerUp(
    serverName: string,
    settings: NotificationSettings,
    serverType?: 'plex' | 'jellyfin' | 'emby'
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromServerUp(serverName, serverType);
    return this.sendAll(payload, settings);
  }

  /**
   * Send a new device notification to all enabled agents
   */
  async notifyNewDevice(
    userName: string,
    deviceName: string,
    platform: string | null,
    location: string | null,
    user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null },
    server: Pick<Server, 'id' | 'name' | 'type'>,
    settings: NotificationSettings
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromNewDevice(
      userName,
      deviceName,
      platform,
      location,
      user,
      server
    );
    return this.sendAll(payload, settings);
  }

  /**
   * Send a trust score changed notification to all enabled agents
   */
  async notifyTrustScoreChanged(
    userName: string,
    previousScore: number,
    newScore: number,
    reason: string | null,
    user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null },
    server: Pick<Server, 'id' | 'name' | 'type'>,
    settings: NotificationSettings
  ): Promise<SendResult[]> {
    const payload = PayloadBuilders.fromTrustScoreChanged(
      userName,
      previousScore,
      newScore,
      reason,
      user,
      server
    );
    return this.sendAll(payload, settings);
  }
}

/**
 * Singleton instance of the NotificationManager
 */
export const notificationManager = new NotificationManager();
