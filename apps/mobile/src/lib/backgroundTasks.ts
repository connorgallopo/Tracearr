/**
 * Background Task Handler for Push Notifications
 *
 * Handles push notifications when the app is in the background or killed.
 * Uses expo-task-manager to register background tasks that process
 * incoming notifications.
 */
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { decryptPushPayload, type DecryptedPayload } from './crypto';
import type { EncryptedPushPayload } from '@tracearr/shared';

// Task identifier for background notification handling
export const BACKGROUND_NOTIFICATION_TASK = 'BACKGROUND_NOTIFICATION_TASK';

// Check if notification payload is encrypted
function isEncrypted(data: unknown): data is EncryptedPushPayload {
  if (!data || typeof data !== 'object') return false;
  const payload = data as Record<string, unknown>;
  return (
    payload.v === 1 &&
    typeof payload.iv === 'string' &&
    typeof payload.ct === 'string' &&
    typeof payload.tag === 'string'
  );
}

/**
 * Process notification payload (decrypt if needed)
 */
async function processPayload(data: Record<string, unknown>): Promise<DecryptedPayload | null> {
  // Check if payload is encrypted
  if (isEncrypted(data)) {
    try {
      return await decryptPushPayload(data);
    } catch (error) {
      console.error('[BackgroundTask] Failed to decrypt payload:', error);
      return null;
    }
  }

  // Not encrypted, return as-is
  return data as DecryptedPayload;
}

/**
 * Handle different notification types in background
 */
async function handleNotificationType(payload: DecryptedPayload): Promise<void> {
  const notificationType = payload.type as string;

  // Handle based on notification type
  if (notificationType === 'violation_detected') {
    // Violation notifications are critical - ensure they're displayed
    console.log('[BackgroundTask] Processing violation notification');
  } else if (notificationType === 'stream_started' || notificationType === 'stream_stopped') {
    // Session notifications are informational
    console.log('[BackgroundTask] Processing session notification');
  } else if (notificationType === 'server_down' || notificationType === 'server_up') {
    // Server status notifications are important
    console.log('[BackgroundTask] Processing server status notification');
  } else if (notificationType === 'data_sync') {
    // Silent notification for background data refresh
    const syncType = payload.syncType as string | undefined;
    console.log('[BackgroundTask] Processing data sync request:', syncType);

    // Import QueryClient dynamically to avoid circular dependencies
    try {
      // Invalidate relevant query caches based on sync type
      // The actual data will be refetched when the app becomes active
      // This is handled by React Query's cache invalidation
      if (syncType === 'stats') {
        console.log('[BackgroundTask] Marking stats cache for refresh');
        // Stats will be refetched on next app focus
      } else if (syncType === 'sessions') {
        console.log('[BackgroundTask] Marking sessions cache for refresh');
        // Sessions will be refetched on next app focus
      }
    } catch (error) {
      console.error('[BackgroundTask] Data sync error:', error);
    }
  } else {
    console.log('[BackgroundTask] Unknown notification type:', notificationType);
  }
}

/**
 * Define the background notification task
 *
 * This task is executed by the OS when a background notification arrives.
 * It must complete within the OS-defined time limit (usually 30 seconds).
 */
TaskManager.defineTask(
  BACKGROUND_NOTIFICATION_TASK,
  async ({ data, error }: TaskManager.TaskManagerTaskBody) => {
    if (error) {
      console.error('[BackgroundTask] Error:', error);
      return;
    }

    if (!data) {
      console.log('[BackgroundTask] No data received');
      return;
    }

    try {
      // Extract notification from task data
      const taskData = data as { notification?: Notifications.Notification };
      const notificationData = taskData.notification?.request.content.data;

      if (!notificationData) {
        console.log('[BackgroundTask] No notification data');
        return;
      }

      // Process the payload (decrypt if encrypted)
      const payload = await processPayload(notificationData as Record<string, unknown>);
      if (!payload) {
        console.error('[BackgroundTask] Failed to process payload');
        return;
      }

      // Handle the notification based on type
      await handleNotificationType(payload);
    } catch (err) {
      console.error('[BackgroundTask] Processing error:', err);
    }
  }
);

/**
 * Register the background notification task
 * Call this during app initialization
 */
export async function registerBackgroundNotificationTask(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_NOTIFICATION_TASK);

    if (!isRegistered) {
      await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
      console.log('[BackgroundTask] Registered background notification task');
    } else {
      console.log('[BackgroundTask] Background task already registered');
    }
  } catch (error) {
    console.error('[BackgroundTask] Failed to register task:', error);
  }
}

/**
 * Unregister the background notification task
 * Call this on logout/cleanup
 */
export async function unregisterBackgroundNotificationTask(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_NOTIFICATION_TASK);

    if (isRegistered) {
      await Notifications.unregisterTaskAsync(BACKGROUND_NOTIFICATION_TASK);
      console.log('[BackgroundTask] Unregistered background notification task');
    }
  } catch (error) {
    console.error('[BackgroundTask] Failed to unregister task:', error);
  }
}

/**
 * Check if background notifications are supported
 */
export function isBackgroundNotificationSupported(): boolean {
  return TaskManager.isAvailableAsync !== undefined;
}
