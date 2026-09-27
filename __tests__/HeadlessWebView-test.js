import { HeadlessWebView } from '../src/HeadlessWebView';
import NativeModule from '../src/NativeRNCWebViewModule';
import { TurboModuleRegistry } from 'react-native';

jest.mock('../src/NativeRNCWebViewModule', () => ({
  __esModule: true,
  default: {
    createHeadless: jest.fn(),
    disposeHeadless: jest.fn(),
    commandHeadless: jest.fn(),
    onHeadlessEvent: jest.fn(),
  },
}));

let listeners;
const source = { uri: 'https://example.com' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function emit(id, type, data = {}) {
  for (const listener of listeners) listener({ id, type, data: JSON.stringify(data) });
}
function lastId() {
  return NativeModule.createHeadless.mock.calls.at(-1)[0];
}

beforeEach(() => {
  jest.spyOn(TurboModuleRegistry, 'getEnforcing').mockReturnValue(NativeModule);
  listeners = new Set();
  NativeModule.createHeadless.mockResolvedValue(undefined);
  NativeModule.disposeHeadless.mockResolvedValue(undefined);
  NativeModule.commandHeadless.mockResolvedValue('null');
  NativeModule.onHeadlessEvent.mockImplementation((listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
});

test('run creates one native instance and calls onCreated before loading', async () => {
  let view;
  const created = jest.fn(() => {
    expect(view.isRunning()).toBe(true);
    expect(NativeModule.commandHeadless).not.toHaveBeenCalled();
  });
  view = new HeadlessWebView({ source, onWebViewCreated: created });
  await Promise.all([view.run(), view.run()]);
  expect(created).toHaveBeenCalledTimes(1);
  expect(NativeModule.createHeadless).toHaveBeenCalledTimes(1);
  expect(NativeModule.commandHeadless).toHaveBeenCalledWith(
    lastId(),
    'load',
    JSON.stringify(source),
  );
  await view.dispose();
  expect(view.isRunning()).toBe(false);
  expect(listeners.size).toBe(0);
});

test('dispose queued during creation destroys the instance exactly once', async () => {
  let complete;
  NativeModule.createHeadless.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = new HeadlessWebView({ source });
  const run = view.run();
  await tick();
  const disposal = view.dispose();
  complete();
  await Promise.all([run, disposal, view.dispose()]);
  expect(NativeModule.disposeHeadless).toHaveBeenCalledTimes(1);
  expect(view.isRunning()).toBe(false);
  expect(listeners.size).toBe(0);
});

test('failed creation cleans up and can be retried', async () => {
  NativeModule.createHeadless.mockRejectedValueOnce(new Error('No active window'));
  const view = new HeadlessWebView({ source });
  await expect(view.run()).rejects.toThrow('No active window');
  expect(listeners.size).toBe(0);
  expect(view.isRunning()).toBe(false);
  await view.run();
  expect(view.isRunning()).toBe(true);
  await view.dispose();
});

test('events are routed only to the owning instance', async () => {
  const first = jest.fn(),
    second = jest.fn();
  const a = new HeadlessWebView({ source, onLoadStop: first });
  const b = new HeadlessWebView({ source, onLoadStop: second });
  await a.run();
  const aId = lastId();
  await b.run();
  emit(aId, 'loadStop', { url: source.uri });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  await a.dispose();
  await b.dispose();
});

test('navigation cancels outstanding async requests immediately', async () => {
  const view = new HeadlessWebView({ source });
  await view.run();
  const result = view.callAsyncJavaScript('return new Promise(() => {});');
  const assertion = expect(result).rejects.toThrow('navigated');
  emit(lastId(), 'loadStart', { url: 'https://example.com/next' });
  await assertion;
  await view.dispose();
});

test('late handler completion is discarded after navigation', async () => {
  let complete;
  const view = new HeadlessWebView({
    source,
    inAppWebViewJavaScriptHandlers: {
      delayed: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  });
  await view.run();
  const id = lastId();
  emit(id, 'message', {
    data: JSON.stringify({
      kind: '__rnc_inappwebview_bridge__',
      type: 'handler-call',
      id: 1,
      handlerName: 'delayed',
      args: [],
      documentId: 'old',
    }),
  });
  await tick();
  emit(id, 'loadStart', { url: 'https://example.com/new' });
  NativeModule.commandHeadless.mockClear();
  complete('old result');
  await tick();
  expect(NativeModule.commandHeadless).not.toHaveBeenCalled();
  await view.dispose();
});

test('registers a JavaScript handler after native creation and returns its value', async () => {
  const callback = jest.fn((value) => ({ accepted: value }));
  const view = new HeadlessWebView({
    source,
    onWebViewCreated: (controller) => controller.addJavaScriptHandler('sendToApp', callback),
  });
  await view.run();
  const id = lastId();
  emit(id, 'message', {
    data: JSON.stringify({
      kind: '__rnc_inappwebview_bridge__',
      type: 'handler-call',
      id: 3,
      handlerName: 'sendToApp',
      args: [42],
      documentId: 'document-a',
    }),
  });
  await tick();
  expect(callback).toHaveBeenCalledWith(42);
  const injection = NativeModule.commandHeadless.mock.calls.find(
    ([, command]) => command === 'inject',
  );
  expect(injection?.[0]).toBe(id);
  expect(JSON.parse(injection[2]).script).toContain('"accepted":42');
  await view.dispose();
});

test('dispose rejects outstanding requests and restart uses a new native ID', async () => {
  const view = new HeadlessWebView({ source });
  await view.run();
  const previous = lastId();
  const result = view.callAsyncJavaScript('return new Promise(() => {});');
  const assertion = expect(result).rejects.toThrow('disposed');
  await view.dispose();
  await assertion;
  await view.run();
  expect(lastId()).not.toBe(previous);
  await view.dispose();
});

test('content process termination resets running state before notifying caller', async () => {
  let view;
  const terminated = jest.fn(() => expect(view.isRunning()).toBe(false));
  view = new HeadlessWebView({ source, onProcessTerminated: terminated });
  await view.run();
  emit(lastId(), 'terminated', { url: source.uri });
  expect(terminated).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  await expect(view.reload()).rejects.toThrow('not running');
});

test('size supports window dimensions and rejects invalid values before native creation', async () => {
  const invalid = new HeadlessWebView({ source, initialSize: { width: -2, height: 1 } });
  await expect(invalid.run()).rejects.toThrow('size');
  expect(NativeModule.createHeadless).not.toHaveBeenCalled();
  const view = new HeadlessWebView({ source, initialSize: { width: -1, height: -1 } });
  await view.run();
  NativeModule.commandHeadless.mockResolvedValueOnce('{"width":390,"height":844}');
  await expect(view.getSize()).resolves.toEqual({ width: 390, height: 844 });
  await view.dispose();
});

test('evaluateJavascript receives the actual native result through the owning controller', async () => {
  const view = new HeadlessWebView({ source });
  await view.run();
  const result = view.evaluateJavascript('({answer: 42})');
  const [id, command, raw] = NativeModule.commandHeadless.mock.calls.at(-1);
  expect(command).toBe('executeJavaScript');
  const payload = JSON.parse(raw);
  expect(payload).toMatchObject({ source: '({answer: 42})', asynchronous: false });
  emit(id, 'message', {
    data: JSON.stringify({
      kind: '__rnc_inappwebview_bridge__',
      type: 'async-result',
      id: payload.id,
      ok: true,
      value: { answer: 42 },
    }),
  });
  await expect(result).resolves.toEqual({ answer: 42 });
  await view.dispose();
});

test('callAsyncJavaScript passes named arguments to native and propagates native failure', async () => {
  const view = new HeadlessWebView({ source });
  await view.run();
  const result = view.callAsyncJavaScript('return await Promise.resolve(left + right);', {
    arguments: { left: 20, right: 22 },
  });
  const rejection = expect(result).rejects.toThrow('execution failed');
  const [id, , raw] = NativeModule.commandHeadless.mock.calls.at(-1);
  const payload = JSON.parse(raw);
  expect(payload.asynchronous).toBe(true);
  expect(JSON.parse(payload.arguments)).toEqual({ left: 20, right: 22 });
  emit(id, 'message', {
    data: JSON.stringify({
      kind: '__rnc_inappwebview_bridge__',
      type: 'async-result',
      id: payload.id,
      ok: false,
      error: 'execution failed',
    }),
  });
  await rejection;
  await view.dispose();
});
