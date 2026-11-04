import { useCallback } from 'react';
import type { WebViewMessageEvent, WebViewSharedProps } from './WebViewTypes';

const protocol = 'ReactNativeWebView.callHandler.v1';

// Installed at both injection times: Android may not expose postMessage at document start.
// Each document owns a session so a late response cannot resolve a new page's request.
export const javaScriptHandlersScript = `;(function () {
  if (window !== window.top) return;
  var bridge = window.ReactNativeWebView;
  if (!bridge || bridge.callHandler) return;
  var session = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var nextId = 0;
  var pending = Object.create(null);
  bridge.callHandler = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var id = String(++nextId);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('JavaScript handler timed out'));
      }, 60000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        bridge.postMessage(JSON.stringify({
          protocol: '${protocol}', session: session, id: id, name: name, args: args
        }));
      } catch (error) {
        clearTimeout(timer);
        delete pending[id];
        reject(error);
      }
    });
  };
  bridge.__resolveHandler = function (response) {
    if (response.session !== session) return;
    var request = pending[response.id];
    if (!request) return;
    clearTimeout(request.timer);
    delete pending[response.id];
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.value);
  };
  window.dispatchEvent(new Event('ReactNativeWebViewReady'));
})();true;\n`;

type Handlers = WebViewSharedProps['javaScriptHandlers'];

/** Returns false for ordinary postMessage payloads, preserving the existing event API. */
export function handleJavaScriptHandlerMessage(
  data: string,
  handlers: NonNullable<Handlers>,
  inject: (script: string) => void,
): boolean {
  let request: unknown;
  try {
    request = JSON.parse(data);
  } catch {
    return false;
  }
  if (!request || typeof request !== 'object') return false;
  const message = request as Record<string, unknown>;
  if (
    message.protocol !== protocol ||
    typeof message.session !== 'string' ||
    typeof message.id !== 'string' ||
    typeof message.name !== 'string' ||
    !Array.isArray(message.args)
  )
    return false;

  const { session, id, name, args } = message;
  const reply = (result: { value?: unknown; error?: string }) => {
    // Encode twice so arbitrary JSON (including script delimiters) is a JS string literal.
    const json = JSON.stringify({ session, id, ...result });
    inject(
      `;(function(){var b=window.ReactNativeWebView;if(b&&b.__resolveHandler)b.__resolveHandler(JSON.parse(${JSON.stringify(json)}));})();true;`,
    );
  };
  Promise.resolve().then(async () => {
    try {
      if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
        throw new Error(`Unknown JavaScript handler: ${name}`);
      }
      const value = await handlers[name](...args);
      reply({ value: value === undefined ? null : value });
    } catch (error) {
      reply({
        error:
          error instanceof Error
            ? error.message || 'JavaScript handler failed'
            : String(error) || 'JavaScript handler failed',
      });
    }
  });
  return true;
}

export function useJavaScriptHandlers(
  handlers: Handlers,
  onMessage: WebViewSharedProps['onMessage'],
  inject: (script: string) => void,
) {
  const receive = useCallback(
    (event: WebViewMessageEvent) => {
      if (handlers && handleJavaScriptHandlerMessage(event.nativeEvent.data, handlers, inject))
        return;
      onMessage?.(event);
    },
    [handlers, onMessage, inject],
  );
  return {
    script: handlers ? javaScriptHandlersScript : '',
    onMessage: handlers ? receive : onMessage,
  };
}
