package com.reactnativecommunity.webview;

import android.app.Activity;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.events.Event;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Owns hidden native views independently of React/Fabric view lifetimes. UI thread only. */
final class RNCHeadlessWebViewManager implements LifecycleEventListener {
    interface EventSink { void emit(String id, String type, String data); }
    private final ReactApplicationContext context;
    private final EventSink sink;
    private final Map<String, HiddenWebView> views = new HashMap<>();
    private boolean invalidated;

    RNCHeadlessWebViewManager(ReactApplicationContext context, EventSink sink) {
        this.context = context;
        this.sink = sink;
        context.addLifecycleEventListener(this);
    }

    private final class HiddenWebView extends RNCWebView {
        final String headlessId;
        final FrameLayout host;
        boolean failed;
        HiddenWebView(ThemedReactContext context, String id) {
            super(context);
            headlessId = id;
            host = new FrameLayout(context);
            host.setVisibility(View.INVISIBLE);
            host.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            host.addView(this, new FrameLayout.LayoutParams(-1, -1));
        }
        @Override public void onMessage(String message, String sourceUrl) {
            emit(this, "message", json("url", sourceUrl, "data", message));
        }
        // No Fabric tag exists for a headless view.
        @Override protected void dispatchEvent(WebView view, Event event) {}
    }

    void create(String id, String optionsJson) throws Exception {
        if (invalidated) throw new IllegalStateException("HeadlessWebView native module was invalidated.");
        if (views.containsKey(id)) throw new IllegalStateException("HeadlessWebView ID already exists.");
        Activity activity = context.getCurrentActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            throw new IllegalStateException("HeadlessWebView requires an active Activity.");
        }
        ViewGroup root = activity.findViewById(android.R.id.content);
        if (root == null) throw new IllegalStateException("Activity has no content view.");
        JSONObject options = new JSONObject(optionsJson);
        HiddenWebView view = new HiddenWebView(new ThemedReactContext(context, activity, "RNCHeadlessWebView", -1), id);
        views.put(id, view);
        try {
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(options.optBoolean("javaScriptEnabled", true));
            settings.setDomStorageEnabled(options.optBoolean("domStorageEnabled", true));
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(options.optBoolean("mediaPlaybackRequiresUserAction", true));
            settings.setCacheMode(options.optBoolean("cacheEnabled", true) ? WebSettings.LOAD_DEFAULT : WebSettings.LOAD_NO_CACHE);
            if (options.has("userAgent")) settings.setUserAgentString(options.getString("userAgent"));
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, options.optBoolean("thirdPartyCookiesEnabled", true));
            if (options.optBoolean("webviewDebuggingEnabled", false)) WebView.setWebContentsDebuggingEnabled(true);
            view.injectedJS = options.optString("injectedJavaScript", "");
            view.setInjectedJSBeforeContentLoaded(options.optString("injectedJavaScriptBeforeContentLoaded", ""));
            JSONArray origins = options.optJSONArray("messagingOriginRules");
            if (origins != null) {
                ArrayList<String> rules = new ArrayList<>();
                for (int i = 0; i < origins.length(); i++) rules.add(origins.getString(i));
                view.setMessagingOriginRules(rules);
            }
            view.setMessagingEnabled(true);
            view.setWebChromeClient(new WebChromeClient() {
                @Override public void onProgressChanged(WebView webView, int progress) {
                    emit(view, "progress", json("url", webView.getUrl(), "progress", progress / 100.0));
                }
            });
            view.setWebViewClient(new WebViewClient() {
                @Override public void onPageStarted(WebView webView, String url, Bitmap icon) {
                    view.failed = false;
                    emit(view, "loadStart", json("url", url));
                    view.callInjectedJavaScriptBeforeContentLoaded();
                }
                @Override public void onPageFinished(WebView webView, String url) {
                    if (view.failed) return;
                    view.callInjectedJavaScript();
                    CookieManager.getInstance().flush();
                    emit(view, "loadStop", json("url", url, "title", webView.getTitle()));
                }
                @Override public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) view.failed = true;
                    emit(view, "error", json("url", request.getUrl().toString(), "code", error.getErrorCode(),
                        "description", error.getDescription().toString(), "isMainFrame", request.isForMainFrame()));
                }
                @Override public void onReceivedHttpError(WebView webView, WebResourceRequest request, WebResourceResponse response) {
                    emit(view, "httpError", json("url", request.getUrl().toString(), "statusCode", response.getStatusCode(),
                        "isMainFrame", request.isForMainFrame()));
                }
                @Override public void onReceivedSslError(WebView webView, SslErrorHandler handler, SslError error) {
                    handler.cancel();
                    emit(view, "error", json("url", error.getUrl(), "code", error.getPrimaryError(), "description", "SSL error"));
                }
                @Override public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    emit(view, "terminated", json("url", webView.getUrl(), "didCrash", detail.didCrash()));
                    dispose(id);
                    return true;
                }
            });
            JSONObject size = options.optJSONObject("initialSize");
            setSize(view, size == null ? json("width", 1, "height", 1) : size);
            root.addView(view.host, 0);
        } catch (Exception error) {
            dispose(id);
            throw error;
        }
    }

    String command(String id, String command, String payloadJson) throws Exception {
        HiddenWebView view = views.get(id);
        if (view == null) throw new IllegalStateException("HeadlessWebView is not running.");
        JSONObject payload = new JSONObject(payloadJson);
        switch (command) {
            case "load":
                String uri = payload.getString("uri");
                Map<String, String> headers = new HashMap<>();
                JSONObject rawHeaders = payload.optJSONObject("headers");
                if (rawHeaders != null) {
                    for (Iterator<String> keys = rawHeaders.keys(); keys.hasNext();) {
                        String key = keys.next();
                        headers.put(key, rawHeaders.getString(key));
                    }
                }
                view.loadUrl(uri, headers);
                break;
            case "reload": view.reload(); break;
            case "stop": view.stopLoading(); break;
            case "executeJavaScript":
                view.executeJavaScript(payload.getDouble("id"), payload.getString("source"), payload.getString("arguments"), payload.getBoolean("asynchronous"));
                break;
            case "inject": view.evaluateJavascriptWithFallback(payload.getString("script")); break;
            case "setSize": setSize(view, payload); break;
            case "getSize":
                float density = context.getResources().getDisplayMetrics().density;
                ViewGroup.LayoutParams params = view.host.getLayoutParams();
                return json("width", params.width / density, "height", params.height / density).toString();
            default: throw new IllegalArgumentException("Unknown headless command: " + command);
        }
        return "null";
    }

    private void setSize(HiddenWebView view, JSONObject size) throws Exception {
        double width = size.getDouble("width"), height = size.getDouble("height");
        if (!Double.isFinite(width) || !Double.isFinite(height) || (width < 0 && width != -1) || (height < 0 && height != -1)) {
            throw new IllegalArgumentException("Invalid headless size.");
        }
        float density = context.getResources().getDisplayMetrics().density;
        View root = view.getRootView();
        Activity activity = context.getCurrentActivity();
        if (activity != null) root = activity.getWindow().getDecorView();
        int w = width == -1 ? root.getWidth() : (int) Math.round(width * density);
        int h = height == -1 ? root.getHeight() : (int) Math.round(height * density);
        view.host.setLayoutParams(new FrameLayout.LayoutParams(w, h));
    }

    void dispose(String id) {
        HiddenWebView view = views.remove(id);
        if (view == null) return;
        view.stopLoading();
        view.setWebViewClient(null);
        view.setWebChromeClient(null);
        if (view.host.getParent() instanceof ViewGroup) ((ViewGroup) view.host.getParent()).removeView(view.host);
        view.host.removeAllViews();
        view.destroy();
    }
    void disposeAll() {
        for (String id : new ArrayList<>(views.keySet())) {
            sink.emit(id, "disposed", "{}");
            dispose(id);
        }
    }
    void invalidate() {
        invalidated = true;
        context.removeLifecycleEventListener(this);
        disposeAll();
    }
    @Override public void onHostResume() {}
    @Override public void onHostPause() {}
    @Override public void onHostDestroy() { disposeAll(); }
    private void emit(HiddenWebView view, String type, JSONObject event) {
        if (views.get(view.headlessId) == view) sink.emit(view.headlessId, type, event.toString());
    }
    private static JSONObject json(Object... values) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < values.length; i += 2) {
                Object value = values[i + 1];
                result.put((String) values[i], value == null && "url".equals(values[i]) ? "" : value);
            }
        } catch (Exception error) { throw new IllegalArgumentException(error); }
        return result;
    }
}
