# Flutter InAppWebView compatibility (iOS)

This fork exposes an opt-in iOS compatibility layer for applications migrating
JavaScript written for `flutter_inappwebview`. It uses `WKWebView`,
`WKScriptMessageHandler`, `WKHTTPCookieStore`, and `URLSession` and presents the
same React Native API as the Android implementation in this fork.

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

Existing page code can call:

```js
const result = await window.flutter_inappwebview.callHandler('sendToApp', {
  cmd: 'initEnv',
});
```

Ordinary messages that are not compatibility-bridge envelopes continue to
reach `onMessage`. iOS validates incoming messages against the sender frame's
`WKSecurityOrigin`; rules may be `*`, a host, an exact origin, or a wildcard
host such as `https://*.example.com`.

## Calling asynchronous JavaScript

`callAsyncJavaScript` correlates each result and rejects on JavaScript errors,
timeout, or WebView unmount. Values must be JSON-compatible.

```ts
const total = await webView.current?.callAsyncJavaScript<number>('return left + right;', {
  arguments: { left: 20, right: 22 },
  timeoutMs: 5000,
});
```

Argument names must be valid, non-reserved JavaScript identifiers. Custom
`WKContentWorld` selection is not currently exposed by this compatibility API.

## Posting string and binary messages

`postWebMessage` dispatches a page `message` event. Base64 binary input is
decoded and delivered as an `ArrayBuffer` without crossing the page-facing API
as text.

```ts
webView.current?.postWebMessage({
  type: 'arrayBuffer',
  data: base64Payload,
  targetOrigin: 'https://example.com',
});
```

When `targetOrigin` is supplied, the native layer compares its scheme, host,
and effective port with the current page before dispatching.

## Optional native proxy command

The iOS native proxy intercepts only this bridge call:

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

Text responses resolve through the Promise. Non-empty binary responses are
sent directly into the page as an `ArrayBuffer`, prefixed by Player Tube's
four-byte, big-endian request id. Only HTTPS targets are allowed, except
`http://localhost` and `http://127.0.0.1`.

The proxy supports `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and
`OPTIONS`, cookies from the WebView's `WKHTTPCookieStore`, redirects,
`__host` and `__headers` query overrides, decoded gzip/deflate/Brotli responses,
text charset decoding, and a 25 MB response limit. It does not expose arbitrary
native HTTP access unless both proxy props are set.
