import vm from 'node:vm';
import {
  buildInAppWebViewBridgeBootstrap,
  buildHandlerResolutionScript,
  buildCallAsyncJavaScriptScript,
} from '../src/InAppWebViewBridge';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function page() {
  const messages = [];
  const events = [];
  const context = vm.createContext({
    Event: function Event(type) {
      return { type };
    },
    window: {
      dispatchEvent: (event) => events.push(event.type),
      ReactNativeWebView: { postMessage: (raw) => messages.push(JSON.parse(raw)) },
    },
  });
  vm.runInContext(buildInAppWebViewBridgeBootstrap(), context);
  return { messages, context, events };
}

test('executes async page code with named arguments and delivers its actual result', async () => {
  const { messages, context } = page();
  vm.runInContext(
    buildCallAsyncJavaScriptScript(12, 'return await Promise.resolve(a + b);', { a: 20, b: 22 }),
    context,
  );
  await tick();
  expect(messages).toEqual([
    expect.objectContaining({ id: 12, type: 'async-result', ok: true, value: 42 }),
  ]);
});

test('handler round trip resolves the correct Promise with a JSON value', async () => {
  const { messages, context } = page();
  const result = vm.runInContext(
    "window.flutter_inappwebview.callHandler('sendToApp', {cmd: 'init'}, 2)",
    context,
  );
  const request = messages[0];
  expect(request.args).toEqual([{ cmd: 'init' }, 2]);
  vm.runInContext(
    buildHandlerResolutionScript(request.id, true, { ready: true }, request.documentId),
    context,
  );
  await expect(result).resolves.toEqual({ ready: true });
});

test('a late response cannot resolve a new document Promise even when request IDs repeat', async () => {
  const oldPage = page();
  vm.runInContext("window.flutter_inappwebview.callHandler('sendToApp')", oldPage.context);
  const oldRequest = oldPage.messages[0];
  const nextPage = page();
  const nextResult = vm.runInContext(
    "window.flutter_inappwebview.callHandler('sendToApp')",
    nextPage.context,
  );
  const nextRequest = nextPage.messages[0];
  expect(nextRequest.id).toBe(oldRequest.id);
  let resolved = false;
  nextResult.then(() => {
    resolved = true;
  });
  vm.runInContext(
    buildHandlerResolutionScript(oldRequest.id, true, 'old', oldRequest.documentId),
    nextPage.context,
  );
  await tick();
  expect(resolved).toBe(false);
  vm.runInContext(
    buildHandlerResolutionScript(nextRequest.id, true, 'new', nextRequest.documentId),
    nextPage.context,
  );
  await expect(nextResult).resolves.toBe('new');
});

test('installs the Flutter object and dispatches readiness once per document', () => {
  const { context, events } = page();
  expect(vm.runInContext('window.flutter_inappwebview._platformReady', context)).toBe(true);
  vm.runInContext(buildInAppWebViewBridgeBootstrap(), context);
  expect(events).toEqual(['flutterInAppWebViewPlatformReady']);
});

test('a rejected handler rejects the page Promise and clears its pending entry', async () => {
  const { context, messages } = page();
  const promise = vm.runInContext("window.flutter_inappwebview.callHandler('fail')", context);
  const rejection = expect(promise).rejects.toThrow('callback failed');
  const request = messages[0];
  vm.runInContext(
    buildHandlerResolutionScript(request.id, false, 'callback failed', request.documentId),
    context,
  );
  await rejection;
  expect(vm.runInContext('window.flutter_inappwebview.__rncBridgePending.size', context)).toBe(0);
});

test('does not announce readiness before native messaging exists', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(buildInAppWebViewBridgeBootstrap(), context);
  expect(context.window.flutter_inappwebview).toBeUndefined();
});

test('unserializable handler results reject the page Promise rather than changing its value', async () => {
  const { context, messages } = page();
  const promise = vm.runInContext("window.flutter_inappwebview.callHandler('circular')", context);
  const rejection = expect(promise).rejects.toThrow('Cannot serialize');
  const circular = {};
  circular.self = circular;
  const request = messages[0];
  vm.runInContext(
    buildHandlerResolutionScript(request.id, true, circular, request.documentId),
    context,
  );
  await rejection;
});
