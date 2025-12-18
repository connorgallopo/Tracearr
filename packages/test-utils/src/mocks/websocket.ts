/**
 * WebSocket Mock for Testing
 *
 * Mock Socket.io client and server utilities for testing real-time events.
 */

export interface SocketEvent {
  event: string;
  data: unknown;
  room?: string;
  timestamp: Date;
}

export interface MockSocketClient {
  id: string;
  connected: boolean;
  rooms: Set<string>;
  data: Record<string, unknown>;

  emit(event: string, ...args: unknown[]): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  off(event: string, callback?: (...args: unknown[]) => void): void;
  join(room: string): void;
  leave(room: string): void;
  disconnect(): void;

  _receivedEvents: SocketEvent[];
  _listeners: Map<string, Set<(...args: unknown[]) => void>>;
  _simulateEvent: (event: string, ...args: unknown[]) => void;
  _reset: () => void;
}

export interface MockSocketServer {
  sockets: Map<string, MockSocketClient>;
  rooms: Map<string, Set<string>>;

  emit(event: string, ...args: unknown[]): void;
  to(room: string): { emit: (event: string, ...args: unknown[]) => void };
  in(room: string): { emit: (event: string, ...args: unknown[]) => void };

  _emittedEvents: SocketEvent[];
  _createClient: (id?: string) => MockSocketClient;
  _removeClient: (id: string) => void;
  _broadcast: (event: string, data: unknown, room?: string) => void;
  _reset: () => void;
}

let clientCounter = 0;

/**
 * Create a mock Socket.io client
 */
export function createMockSocketClient(id?: string): MockSocketClient {
  const clientId = id ?? `socket-${++clientCounter}`;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const receivedEvents: SocketEvent[] = [];
  const rooms = new Set<string>();

  const client: MockSocketClient = {
    id: clientId,
    connected: true,
    rooms,
    data: {},

    _receivedEvents: receivedEvents,
    _listeners: listeners,

    emit(event: string, ...args: unknown[]) {
      receivedEvents.push({
        event,
        data: args.length === 1 ? args[0] : args,
        timestamp: new Date(),
      });
    },

    on(event: string, callback: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(callback);
    },

    off(event: string, callback?: (...args: unknown[]) => void) {
      if (callback) {
        listeners.get(event)?.delete(callback);
      } else {
        listeners.delete(event);
      }
    },

    join(room: string) {
      rooms.add(room);
    },

    leave(room: string) {
      rooms.delete(room);
    },

    disconnect() {
      client.connected = false;
      rooms.clear();
      const disconnectCallbacks = listeners.get('disconnect');
      if (disconnectCallbacks) {
        for (const cb of disconnectCallbacks) {
          cb();
        }
      }
    },

    _simulateEvent(event: string, ...args: unknown[]) {
      const callbacks = listeners.get(event);
      if (callbacks) {
        for (const cb of callbacks) {
          cb(...args);
        }
      }
    },

    _reset() {
      receivedEvents.length = 0;
      listeners.clear();
      rooms.clear();
      client.connected = true;
      client.data = {};
    },
  };

  return client;
}

/**
 * Create a mock Socket.io server
 */
export function createMockSocketServer(): MockSocketServer {
  const sockets = new Map<string, MockSocketClient>();
  const rooms = new Map<string, Set<string>>();
  const emittedEvents: SocketEvent[] = [];

  const server: MockSocketServer = {
    sockets,
    rooms,
    _emittedEvents: emittedEvents,

    emit(event: string, ...args: unknown[]) {
      const data = args.length === 1 ? args[0] : args;
      emittedEvents.push({
        event,
        data,
        timestamp: new Date(),
      });
      // Emit to all connected clients
      for (const client of sockets.values()) {
        if (client.connected) {
          client._simulateEvent(event, ...args);
        }
      }
    },

    to(room: string) {
      return {
        emit(event: string, ...args: unknown[]) {
          const data = args.length === 1 ? args[0] : args;
          emittedEvents.push({
            event,
            data,
            room,
            timestamp: new Date(),
          });
          // Emit to clients in the room
          const clientIds = rooms.get(room);
          if (clientIds) {
            for (const clientId of clientIds) {
              const client = sockets.get(clientId);
              if (client?.connected) {
                client._simulateEvent(event, ...args);
              }
            }
          }
        },
      };
    },

    in(room: string) {
      return server.to(room);
    },

    _createClient(id?: string) {
      const client = createMockSocketClient(id);
      sockets.set(client.id, client);

      // Track room membership
      const originalJoin = client.join.bind(client);
      client.join = (room: string) => {
        originalJoin(room);
        if (!rooms.has(room)) {
          rooms.set(room, new Set());
        }
        rooms.get(room)!.add(client.id);
      };

      const originalLeave = client.leave.bind(client);
      client.leave = (room: string) => {
        originalLeave(room);
        rooms.get(room)?.delete(client.id);
      };

      const originalDisconnect = client.disconnect.bind(client);
      client.disconnect = () => {
        originalDisconnect();
        // Remove from all rooms
        for (const roomClients of rooms.values()) {
          roomClients.delete(client.id);
        }
      };

      return client;
    },

    _removeClient(id: string) {
      const client = sockets.get(id);
      if (client) {
        client.disconnect();
        sockets.delete(id);
      }
    },

    _broadcast(event: string, data: unknown, room?: string) {
      if (room) {
        server.to(room).emit(event, data);
      } else {
        server.emit(event, data);
      }
    },

    _reset() {
      for (const client of sockets.values()) {
        client._reset();
      }
      sockets.clear();
      rooms.clear();
      emittedEvents.length = 0;
      clientCounter = 0;
    },
  };

  return server;
}

/**
 * Reset client counter
 */
export function resetSocketCounter(): void {
  clientCounter = 0;
}

/**
 * Create a mock getIO function for testing
 */
export function createMockGetIO(server: MockSocketServer): () => MockSocketServer {
  return () => server;
}

/**
 * Create mock broadcast functions
 */
export function createMockBroadcasters(server: MockSocketServer) {
  return {
    broadcastToSessions: (event: string, data: unknown) => {
      server.to('sessions').emit(event, data);
    },
    broadcastToServer: (serverId: string, event: string, data: unknown) => {
      server.to(`server:${serverId}`).emit(event, data);
    },
    broadcastToUser: (userId: string, event: string, data: unknown) => {
      server.to(`user:${userId}`).emit(event, data);
    },
    broadcastToAll: (event: string, data: unknown) => {
      server.emit(event, data);
    },
  };
}

/**
 * Typed events for Tracearr WebSocket
 */
export type TracearrServerEvent =
  | 'session:started'
  | 'session:stopped'
  | 'session:updated'
  | 'violation:new'
  | 'stats:updated'
  | 'import:progress';

export type TracearrClientEvent = 'subscribe:sessions' | 'unsubscribe:sessions';

/**
 * Helper to wait for a specific event
 */
export function waitForEvent(
  client: MockSocketClient,
  event: string,
  timeout = 1000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeout);

    client.on(event, (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Helper to collect multiple events
 */
export function collectEvents(client: MockSocketClient, event: string, count: number): unknown[] {
  const collected: unknown[] = [];
  client.on(event, (data: unknown) => {
    if (collected.length < count) {
      collected.push(data);
    }
  });
  return collected;
}
