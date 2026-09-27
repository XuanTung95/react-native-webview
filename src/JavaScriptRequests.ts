import {
  validateJavaScriptArguments,
  type JavaScriptEvaluationOptions,
} from './InAppWebViewBridge';

let nextRequestId = 0;

/** One request registry per controller, shared by native evaluation and async evaluation. */
export class JavaScriptRequests {
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  run<T>(
    send: (id: number) => void | Promise<void>,
    options: JavaScriptEvaluationOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('timeoutMs must be a positive finite number.'));
    }
    nextRequestId += 1;
    const id = nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.finish(id, false, `JavaScript request ${id} timed out.`),
        timeoutMs,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        Promise.resolve(send(id)).catch((error) => this.finish(id, false, String(error)));
      } catch (error) {
        this.finish(id, false, String(error));
      }
    });
  }

  finish(id: number, ok: boolean, value: unknown): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (ok) request.resolve(value);
    else request.reject(new Error(String(value ?? 'JavaScript execution failed.')));
  }

  cancel(reason: string): void {
    for (const id of this.pending.keys()) this.finish(id, false, reason);
  }
}

export function serializeJavaScriptArguments(args: Readonly<Record<string, unknown>> = {}): string {
  validateJavaScriptArguments(args);
  return JSON.stringify(args);
}
