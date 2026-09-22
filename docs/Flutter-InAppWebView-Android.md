# Flutter InAppWebView compatibility (Android)

This fork exposes a small Android compatibility layer for applications migrating
JavaScript written for `flutter_inappwebview`. All additions are opt-in.

## Promise-based JavaScript handlers

Passing `inAppWebViewJavaScriptHandlers` installs
`window.flutter_inappwebview.callHandler` before page scripts run. A handler may
return a value or a Promise. Rejections are propagated to the Promise in the
page.

```tsx
const webView = useRef<WebView>(null);

<WebView
  ref={webView}
  source={{ uri: 'https://example.com' }}
  messagingOriginRules={['https://example.com']}
  inAppWebViewJavaScriptHandlers={{
    sendToApp: async (command) => handleCommand(command),
  }}
/>;
```

The existing page code can then call:

```js
const result = await window.flutter_inappwebview.callHandler('sendToApp', { cmd: 'initEnv' });
```

Ordinary messages that are not bridge envelopes continue to reach `onMessage`.

## Calling asynchronous JavaScript

`callAsyncJavaScript` correlates each result and rejects on JavaScript errors,
timeout, or WebView unmount. Values must be JSON-compatible.

```ts
const total = await webView.current?.callAsyncJavaScript<number>('return left + right;', {
  arguments: { left: 20, right: 22 },
  timeoutMs: 5000,
});
```

Argument names must be valid, non-reserved JavaScript identifiers. Android
content worlds are not currently implemented.

## AndroidX WebMessage

`postWebMessage` sends strings or Base64-encoded binary data. Binary data is
decoded natively and delivered to the page as an `ArrayBuffer` when the Android
WebView supports it. Older WebViews use a JavaScript fallback.

```ts
webView.current?.postWebMessage({
  type: 'arrayBuffer',
  data: base64Payload,
  targetOrigin: 'https://example.com',
});
```

Set `messagingOriginRules` to the narrowest AndroidX origin rules your page
needs. The default remains `['*']` for compatibility with upstream behavior.

## Optional native proxy command

The Android native proxy intercepts only this bridge call:

```js
window.flutter_inappwebview.callHandler('sendToApp', {
  cmd: 'proxy',
  id: 1,
  url: 'https://media.example.com/file',
  method: 'GET',
  headers: { cors: 'https://example.com' },
});
```

Enable it with an explicit target-host allowlist:

```tsx
<WebView
  nativeProxyEnabled
  nativeProxyAllowedHosts={['media.example.com', '*.googlevideo.com']}
  // ...
/>
```

Text responses are returned through the Promise. Non-empty binary responses
are sent directly from Android to the page as an `ArrayBuffer`, prefixed by the
four-byte, big-endian request id used by Player Tube's Flutter proxy. Only HTTPS
targets are allowed, except `http://localhost` and `http://127.0.0.1`.

The proxy supports `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and
`OPTIONS`, cookies from Android's `CookieManager`, `__host` and `__headers`
query overrides, redirects, text charset decoding, and a 25 MB response limit.
It does not expose arbitrary native HTTP access unless both proxy props are set.
