/** @jest-environment node */
const vm = require('node:vm');
const {
  javaScriptHandlersScript,
  handleJavaScriptHandlerMessage,
} = require('../WebViewJavaScriptHandlers');

const page = (handlers) => {
  const context = vm.createContext({ setTimeout, clearTimeout, Event: jest.fn() });
  context.window = context;
  context.top = context;
  context.dispatchEvent = jest.fn();
  context.ReactNativeWebView = {
    postMessage: (data) =>
      handleJavaScriptHandlerMessage(data, handlers, (script) => vm.runInContext(script, context)),
  };
  vm.runInContext(javaScriptHandlersScript, context);
  return context;
};

test('concurrent calls receive their own async JSON responses', async () => {
  const context = page({ echo: async (data) => data });
  const values = [{ quote: "'</script>\u2028", nested: [1, null] }, { id: 2 }];
  const results = await Promise.all(
    values.map((value) => context.ReactNativeWebView.callHandler('echo', value)),
  );
  expect(JSON.parse(JSON.stringify(results))).toEqual(values);
});

test('handler errors, missing handlers, and unserializable responses reject', async () => {
  const context = page({
    fail: () => {
      throw new Error('failure');
    },
    invalid: () => BigInt(1),
  });
  await expect(context.ReactNativeWebView.callHandler('fail')).rejects.toThrow('failure');
  await expect(context.ReactNativeWebView.callHandler('toString')).rejects.toThrow(
    'Unknown JavaScript handler',
  );
  await expect(context.ReactNativeWebView.callHandler('invalid')).rejects.toThrow();
});

test('ordinary and malformed messages pass through', () => {
  for (const data of [
    'hello',
    'null',
    '42',
    '{}',
    '{"protocol":"ReactNativeWebView.callHandler.v1"}',
  ]) {
    expect(handleJavaScriptHandlerMessage(data, {}, jest.fn())).toBe(false);
  }
});

test('double installation preserves in-flight requests and undefined returns null', async () => {
  let resolve;
  const context = page({
    wait: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const result = context.ReactNativeWebView.callHandler('wait');
  await Promise.resolve();
  vm.runInContext(javaScriptHandlersScript, context);
  resolve();
  await expect(result).resolves.toBeNull();
  expect(context.dispatchEvent).toHaveBeenCalledTimes(1);
});

test('responses from another document are ignored and requests time out', async () => {
  jest.useFakeTimers();
  try {
    const context = page({ never: () => new Promise(() => {}) });
    const result = context.ReactNativeWebView.callHandler('never');
    context.ReactNativeWebView['__resolveHandler']({
      session: 'old-document',
      id: '1',
      value: 'wrong',
    });
    const rejection = expect(result).rejects.toThrow('timed out');
    jest.advanceTimersByTime(60000);
    await rejection;
  } finally {
    jest.useRealTimers();
  }
});

test('non-JSON arguments reject immediately', async () => {
  const context = page({ echo: (value) => value });
  const circular = {};
  circular.self = circular;
  await expect(context.ReactNativeWebView.callHandler('echo', circular)).rejects.toThrow();
});
