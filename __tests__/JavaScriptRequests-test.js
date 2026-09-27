import { JavaScriptRequests, serializeJavaScriptArguments } from '../src/JavaScriptRequests';

test('correlates concurrent native results including strings without double decoding', async () => {
  const requests = new JavaScriptRequests();
  const ids = [];
  const a = requests.run((id) => {
    ids.push(id);
  });
  const b = requests.run((id) => {
    ids.push(id);
  });
  requests.finish(ids[1], true, '{"nested":42}');
  requests.finish(ids[0], true, { answer: 42 });
  await expect(a).resolves.toEqual({ answer: 42 });
  await expect(b).resolves.toBe('{"nested":42}');
});

test('cancellation rejects old requests and late results cannot settle a new request', async () => {
  const requests = new JavaScriptRequests();
  let oldId, newId;
  const old = requests.run((id) => {
    oldId = id;
  });
  const rejection = expect(old).rejects.toThrow('navigated');
  requests.cancel('navigated');
  await rejection;
  const next = requests.run((id) => {
    newId = id;
  });
  requests.finish(oldId, true, 'stale');
  requests.finish(newId, true, 'current');
  await expect(next).resolves.toBe('current');
});

test('times out an unfulfilled request and propagates synchronous native dispatch errors', async () => {
  jest.useFakeTimers();
  try {
    const requests = new JavaScriptRequests();
    const waiting = requests.run(() => {}, { timeoutMs: 25 });
    const rejected = expect(waiting).rejects.toThrow('timed out');
    jest.advanceTimersByTime(25);
    await rejected;
    await expect(
      requests.run(() => {
        throw new Error('native unavailable');
      }),
    ).rejects.toThrow('native unavailable');
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('rejects invalid arguments instead of silently replacing them', () => {
  expect(() => serializeJavaScriptArguments({ await: 1 })).toThrow('argument name');
  const circular = {};
  circular.self = circular;
  expect(() => serializeJavaScriptArguments(circular)).toThrow();
});

test('different controllers cannot reuse request IDs when a native view is recycled', async () => {
  const first = new JavaScriptRequests(),
    second = new JavaScriptRequests();
  let firstId, secondId;
  const a = first.run((id) => {
    firstId = id;
  });
  const b = second.run((id) => {
    secondId = id;
  });
  expect(firstId).not.toBe(secondId);
  first.finish(firstId, true, 'a');
  second.finish(firstId, true, 'stale');
  second.finish(secondId, true, 'b');
  await expect(a).resolves.toBe('a');
  await expect(b).resolves.toBe('b');
});
