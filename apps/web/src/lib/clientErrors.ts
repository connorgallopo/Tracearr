export interface CapturedError {
  id: number;
  at: string;
  source: string;
  message: string;
  stack?: string;
}

const MAX_CAPTURED = 50;
const captured: CapturedError[] = [];
let nextId = 1;

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  if (typeof err === 'string') return { message: err };
  return { message: JSON.stringify(err) ?? String(err) };
}

export function recordClientError(source: string, err: unknown): void {
  const { message, stack } = describe(err);
  captured.unshift({ id: nextId++, at: new Date().toISOString(), source, message, stack });
  if (captured.length > MAX_CAPTURED) captured.length = MAX_CAPTURED;
  console.error(`[${source}]`, err);
}

export function getClientErrors(): CapturedError[] {
  return [...captured];
}

export function clearClientErrors(): void {
  captured.length = 0;
}

export function installClientErrorCapture(): void {
  window.addEventListener('error', (event) => {
    recordClientError('window', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordClientError('unhandled rejection', event.reason);
  });
}
