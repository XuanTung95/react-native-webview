import {
  IN_APP_WEBVIEW_BRIDGE_KIND,
  buildCallAsyncJavaScriptScript,
  buildHandlerResolutionScript,
  buildInAppWebViewBridgeBootstrap,
  parseInAppWebViewBridgeEnvelope,
} from '../src/InAppWebViewBridge';

describe('InAppWebViewBridge', () => {
  test('parses handler calls and async results', () => {
    expect(
      parseInAppWebViewBridgeEnvelope(
        JSON.stringify({
          kind: IN_APP_WEBVIEW_BRIDGE_KIND,
          type: 'handler-call',
          id: 7,
          handlerName: 'sendToApp',
          args: [{ cmd: 'initEnv' }],
        }),
      ),
    ).toMatchObject({ id: 7, handlerName: 'sendToApp' });
    expect(
      parseInAppWebViewBridgeEnvelope(
        JSON.stringify({
          kind: IN_APP_WEBVIEW_BRIDGE_KIND,
          type: 'async-result',
          id: 8,
          ok: true,
          value: { ready: true },
        }),
      ),
    ).toMatchObject({ id: 8, ok: true });
  });

  test('ignores malformed and unrelated messages', () => {
    expect(parseInAppWebViewBridgeEnvelope('not json')).toBeUndefined();
    expect(parseInAppWebViewBridgeEnvelope('{"kind":"other","id":1}')).toBeUndefined();
    expect(
      parseInAppWebViewBridgeEnvelope(
        JSON.stringify({
          kind: IN_APP_WEBVIEW_BRIDGE_KIND,
          type: 'handler-call',
          id: 'wrong',
          handlerName: 'sendToApp',
          args: [],
        }),
      ),
    ).toBeUndefined();
  });

  test('normalizes iOS native numeric booleans so evaluation results settle', () => {
    const success = parseInAppWebViewBridgeEnvelope(
      JSON.stringify({
        kind: IN_APP_WEBVIEW_BRIDGE_KIND,
        type: 'async-result',
        id: 7,
        ok: 1,
        value: { title: 'Example Domain', answer: 42 },
      }),
    );
    expect(success).toMatchObject({ type: 'async-result', id: 7, ok: true, value: { answer: 42 } });

    const failure = parseInAppWebViewBridgeEnvelope(
      JSON.stringify({
        kind: IN_APP_WEBVIEW_BRIDGE_KIND,
        type: 'async-result',
        id: 8,
        ok: 0,
        error: 'execution failed',
      }),
    );
    expect(failure).toMatchObject({
      type: 'async-result',
      id: 8,
      ok: false,
      error: 'execution failed',
    });
    expect(
      parseInAppWebViewBridgeEnvelope(
        JSON.stringify({
          kind: IN_APP_WEBVIEW_BRIDGE_KIND,
          type: 'async-result',
          id: 9,
          ok: '1',
        }),
      ),
    ).toBeUndefined();
  });

  test('generates the Flutter-compatible Promise bridge', () => {
    const script = buildInAppWebViewBridgeBootstrap();
    expect(script).toContain('window.flutter_inappwebview');
    expect(script).toContain('bridge.callHandler');
    expect(script).toContain("type: 'handler-call'");
  });

  test('escapes values injected into handler resolutions', () => {
    const script = buildHandlerResolutionScript(3, true, 'before\u2028after');
    expect(script).toContain('\\u2028');
    expect(script).not.toContain('before\u2028after');
  });

  test('wraps an async function body in a correlated response', () => {
    const script = buildCallAsyncJavaScriptScript(9, 'return left + right;', {
      left: 20,
      right: 22,
    });
    expect(script).toContain('return left + right;');
    expect(script).toContain("type: 'async-result', id: 9");
    expect(script).toContain('async function (left, right)');
  });

  test('rejects invalid async function argument names before injection', () => {
    expect(() => buildCallAsyncJavaScriptScript(10, 'return value;', { 'not-valid': 1 })).toThrow(
      "Invalid async JavaScript argument name 'not-valid'.",
    );
  });
});
