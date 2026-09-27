export const IN_APP_WEBVIEW_BRIDGE_KIND = '__rnc_inappwebview_bridge__';

export type InAppWebViewJavaScriptHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export type InAppWebViewJavaScriptHandlers = Readonly<
  Record<string, InAppWebViewJavaScriptHandler>
>;

export type JavaScriptEvaluationOptions = Readonly<{ timeoutMs?: number }>;

export type CallAsyncJavaScriptOptions = Readonly<{
  /** Values exposed as named parameters inside the async function body. */
  arguments?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
}>;

export type PostWebMessage = Readonly<{
  /** String data, or Base64 when type is `arrayBuffer`. */
  data: string;
  type?: 'string' | 'arrayBuffer';
  targetOrigin?: string;
}>;

type BridgeCallEnvelope = Readonly<{
  kind: typeof IN_APP_WEBVIEW_BRIDGE_KIND;
  type: 'handler-call';
  id: number;
  handlerName: string;
  args: unknown[];
  documentId?: string;
}>;

type AsyncResultEnvelope = Readonly<{
  kind: typeof IN_APP_WEBVIEW_BRIDGE_KIND;
  type: 'async-result';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: unknown;
}>;

export type InAppWebViewBridgeEnvelope = BridgeCallEnvelope | AsyncResultEnvelope;

export function parseInAppWebViewBridgeEnvelope(
  raw: string,
): InAppWebViewBridgeEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== IN_APP_WEBVIEW_BRIDGE_KIND || typeof envelope.id !== 'number') {
    return undefined;
  }
  if (
    envelope.type === 'handler-call' &&
    typeof envelope.handlerName === 'string' &&
    Array.isArray(envelope.args)
  ) {
    return envelope as unknown as BridgeCallEnvelope;
  }
  if (envelope.type === 'async-result') {
    if (typeof envelope.ok === 'boolean') return envelope as unknown as AsyncResultEnvelope;
    // Older iOS builds serialized NSNumber boolean values as JSON 0/1.
    if (envelope.ok === 0 || envelope.ok === 1) {
      return { ...envelope, ok: envelope.ok === 1 } as AsyncResultEnvelope;
    }
  }
  return undefined;
}

function javaScriptValue(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) throw new Error('JavaScript bridge value is not JSON-compatible.');
  return serialized.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function buildInAppWebViewBridgeBootstrap(): string {
  return `
(function () {
  if (!window.ReactNativeWebView || typeof window.ReactNativeWebView.postMessage !== 'function') return false;
  var bridge = window.flutter_inappwebview = window.flutter_inappwebview || {};
  if (bridge.__rncBridgeInstalled === true) return true;
  bridge.__rncBridgeInstalled = true;
  bridge.__rncBridgeCounter = 1;
  bridge.__rncDocumentId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  bridge.__rncBridgePending = new Map();
  bridge.__rncBridgeResolve = function (id, ok, value) {
    var pending = bridge.__rncBridgePending.get(id);
    if (!pending) return;
    bridge.__rncBridgePending.delete(id);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(String(value || 'Native bridge failed.')));
  };
  bridge.callHandler = function (handlerName) {
    var args = Array.prototype.slice.call(arguments, 1);
    var id = bridge.__rncBridgeCounter++;
    return new Promise(function (resolve, reject) {
      bridge.__rncBridgePending.set(id, {resolve: resolve, reject: reject});
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          kind: '${IN_APP_WEBVIEW_BRIDGE_KIND}',
          type: 'handler-call',
          id: id,
          documentId: bridge.__rncDocumentId,
          handlerName: String(handlerName),
          args: args
        }));
      } catch (error) {
        bridge.__rncBridgePending.delete(id);
        reject(error);
      }
    });
  };
  bridge._platformReady = true;
  window.dispatchEvent(new Event('flutterInAppWebViewPlatformReady'));
  return true;
})();
true;
`;
}

export function buildHandlerResolutionScript(
  id: number,
  ok: boolean,
  value: unknown,
  documentId?: string,
): string {
  const guard =
    documentId === undefined
      ? ''
      : `window.flutter_inappwebview.__rncDocumentId === ${javaScriptValue(documentId)} && `;
  let encodedValue: string;
  let success = ok;
  try {
    encodedValue = javaScriptValue(value);
  } catch (error) {
    success = false;
    encodedValue = javaScriptValue(`Cannot serialize JavaScript handler result: ${String(error)}`);
  }
  return `window.flutter_inappwebview && ${guard}window.flutter_inappwebview.__rncBridgeResolve(${id}, ${success}, ${encodedValue}); true;`;
}

const RESERVED_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

export function validateJavaScriptArguments(args: Readonly<Record<string, unknown>>): void {
  const names = Object.keys(args);
  const invalidName = names.find(
    (name) => !/^[$A-Z_a-z][$\w]*$/.test(name) || RESERVED_WORDS.has(name),
  );
  if (invalidName) {
    throw new Error(`Invalid async JavaScript argument name '${invalidName}'.`);
  }
}

export function buildCallAsyncJavaScriptScript(
  id: number,
  functionBody: string,
  args: Readonly<Record<string, unknown>> = {},
): string {
  validateJavaScriptArguments(args);
  const names = Object.keys(args);
  const values = names.map((name) => `args[${javaScriptValue(name)}]`).join(', ');
  return `
(async function () {
  try {
    var args = ${javaScriptValue(args)};
    var value = await (async function (${names.join(', ')}) {\n${functionBody}\n}).call(window, ${values});
    window.ReactNativeWebView.postMessage(JSON.stringify({
      kind: '${IN_APP_WEBVIEW_BRIDGE_KIND}', type: 'async-result', id: ${id}, ok: true, value: value
    }));
  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      kind: '${IN_APP_WEBVIEW_BRIDGE_KIND}', type: 'async-result', id: ${id}, ok: false,
      error: error && error.message ? error.message : String(error)
    }));
  }
})();
true;
`;
}
