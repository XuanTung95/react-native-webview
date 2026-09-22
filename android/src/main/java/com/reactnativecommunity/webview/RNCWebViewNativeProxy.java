package com.reactnativecommunity.webview;

import android.net.Uri;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Optional native implementation of flutter_inappwebview's proxy command.
 * Binary responses are delivered directly to the page and never cross the RN bridge.
 */
final class RNCWebViewNativeProxy {
    private static final String BRIDGE_KIND = "__rnc_inappwebview_bridge__";
    private static final long MAX_RESPONSE_BYTES = 25_000_000L;
    private static final Set<String> METHODS = Set.of(
            "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"
    );
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build();

    private RNCWebViewNativeProxy() {}

    static boolean tryHandle(
            @NonNull RNCWebView webView,
            @NonNull String rawMessage,
            @NonNull Set<String> allowedHosts
    ) {
        try {
            JSONObject envelope = new JSONObject(rawMessage);
            if (!BRIDGE_KIND.equals(envelope.optString("kind")) ||
                    !"handler-call".equals(envelope.optString("type")) ||
                    !"sendToApp".equals(envelope.optString("handlerName"))) {
                return false;
            }
            JSONArray args = envelope.optJSONArray("args");
            JSONObject command = args != null ? args.optJSONObject(0) : null;
            if (command == null || !"proxy".equals(command.optString("cmd"))) {
                return false;
            }
            int callId = envelope.getInt("id");
            execute(webView, callId, command, allowedHosts);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void execute(
            @NonNull RNCWebView webView,
            int callId,
            @NonNull JSONObject command,
            @NonNull Set<String> allowedHosts
    ) {
        final int requestId = command.optInt("id", -1);
        final String rawUrl = command.optString("url", "");
        final String method = command.optString("method", "GET").trim().toUpperCase(Locale.US);
        final String corsOrigin;
        final HttpUrl target;
        final Request request;
        try {
            if (requestId < 0 || rawUrl.isEmpty() || !METHODS.contains(method)) {
                throw new IllegalArgumentException("Invalid proxy request.");
            }
            HttpUrl parsed = HttpUrl.get(rawUrl);
            String hostOverride = parsed.queryParameter("__host");
            HttpUrl.Builder urlBuilder = parsed.newBuilder()
                    .removeAllQueryParameters("__host")
                    .removeAllQueryParameters("__headers");
            if (hostOverride != null && !hostOverride.isEmpty()) {
                urlBuilder.scheme("https").host(hostOverride).port(443);
            }
            target = urlBuilder.build();
            if (!isAllowed(target.host(), target.scheme(), allowedHosts)) {
                throw new SecurityException("Proxy target is not allowed.");
            }

            JSONObject headers = command.optJSONObject("headers");
            corsOrigin = headers != null ? headers.optString("cors", "*") : "*";
            Request.Builder builder = new Request.Builder().url(target);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String name = keys.next();
                    if ("cors".equalsIgnoreCase(name) || isUnsafeHeader(name)) continue;
                    Object value = headers.opt(name);
                    if (value != null && value != JSONObject.NULL) {
                        builder.header(name, String.valueOf(value));
                    }
                }
            }
            applyEncodedHeaders(parsed.queryParameter("__headers"), builder);

            if (isYoutubeHost(target.host())) {
                String youtubeOrigin = "https://" + target.host();
                if (builder.build().header("Origin") == null) {
                    builder.header("Origin", youtubeOrigin);
                }
                if (builder.build().header("Referer") == null) {
                    builder.header("Referer", youtubeOrigin + "/");
                }
            }

            String cookie = android.webkit.CookieManager.getInstance().getCookie(target.toString());
            if (cookie != null && !cookie.isEmpty() && builder.build().header("Cookie") == null) {
                builder.header("Cookie", cookie);
            }

            byte[] body = null;
            Object bodyValue = command.opt("body");
            Object bodyBase64Value = command.opt("bodyBase64");
            if (bodyValue instanceof String) {
                body = ((String) bodyValue).getBytes(StandardCharsets.UTF_8);
            } else if (bodyBase64Value instanceof String) {
                body = Base64.decode((String) bodyBase64Value, Base64.DEFAULT);
            }
            RequestBody requestBody = null;
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                String contentType = builder.build().header("Content-Type");
                if (contentType == null && bodyValue instanceof String) {
                    String trimmed = ((String) bodyValue).trim();
                    contentType = trimmed.startsWith("{") || trimmed.startsWith("[")
                            ? "application/json; charset=utf-8"
                            : "text/plain; charset=utf-8";
                }
                if (contentType == null) contentType = "application/octet-stream";
                requestBody = RequestBody.create(body != null ? body : new byte[0], MediaType.parse(contentType));
            }
            request = builder.method(method, requestBody).build();
        } catch (Exception error) {
            resolve(webView, callId, errorResponse(requestId, rawUrl, error), null);
            return;
        }

        if ("OPTIONS".equals(method)) {
            resolve(webView, callId, responseJson(requestId, 200, target.toString(), corsOrigin, true), null);
            return;
        }

        CLIENT.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(@NonNull Call call, @NonNull IOException error) {
                resolve(webView, callId, errorResponse(requestId, target.toString(), error), null);
            }

            @Override
            public void onResponse(@NonNull Call call, @NonNull Response response) {
                try (Response closeable = response) {
                    ResponseBody responseBody = closeable.body();
                    long declaredLength = responseBody != null ? responseBody.contentLength() : 0;
                    if (declaredLength > MAX_RESPONSE_BYTES) {
                        throw new IOException("Proxy response is too large.");
                    }
                    byte[] bytes = responseBody != null ? responseBody.bytes() : new byte[0];
                    if (bytes.length > MAX_RESPONSE_BYTES) {
                        throw new IOException("Proxy response is too large.");
                    }
                    String contentEncoding = closeable.header("content-encoding", "")
                            .trim().toLowerCase(Locale.US);
                    boolean decodedContent = contentEncoding.contains("gzip") ||
                            contentEncoding.contains("deflate");
                    bytes = decodeContent(bytes, contentEncoding);
                    if (bytes.length > MAX_RESPONSE_BYTES) {
                        throw new IOException("Decoded proxy response is too large.");
                    }
                    JSONObject result = responseJson(
                            requestId,
                            closeable.code(),
                            rawUrl,
                            corsOrigin,
                            false
                    );
                    JSONObject resultHeaders = result.getJSONObject("headers");
                    for (String name : closeable.headers().names()) {
                        String lowerName = name.toLowerCase(Locale.US);
                        if (command.optBoolean("fullHeader") ||
                                Set.of("content-length", "content-type", "content-disposition", "accept-ranges", "content-range").contains(lowerName)) {
                            resultHeaders.put(lowerName, closeable.header(name));
                        }
                    }
                    if (decodedContent) {
                        resultHeaders.remove("content-encoding");
                        resultHeaders.remove("content-length");
                    }
                    String contentType = closeable.header("content-type", "").toLowerCase(Locale.US);
                    if (isText(contentType)) {
                        result.put("bodyType", "string");
                        result.put("body", decodeText(bytes, contentType));
                        resolve(webView, callId, result, null);
                    } else if (bytes.length == 0) {
                        result.put("bodyType", "string");
                        result.put("body", JSONObject.NULL);
                        resolve(webView, callId, result, null);
                    } else {
                        result.put("bodyType", "webMessage");
                        result.put("body", JSONObject.NULL);
                        resolve(webView, callId, result, withRequestId(requestId, bytes));
                    }
                } catch (Exception error) {
                    resolve(webView, callId, errorResponse(requestId, target.toString(), error), null);
                }
            }
        });
    }

    private static JSONObject responseJson(int id, int status, String url, String origin, boolean includeMaxAge) {
        JSONObject response = new JSONObject();
        JSONObject headers = new JSONObject();
        try {
            response.put("id", id);
            response.put("status", status);
            response.put("bodyType", "string");
            response.put("body", JSONObject.NULL);
            response.put("url", url);
            headers.put("Access-Control-Allow-Origin", origin);
            headers.put("Access-Control-Allow-Headers", "*");
            headers.put("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
            if (!"*".equals(origin)) headers.put("Access-Control-Allow-Credentials", "true");
            if (includeMaxAge) headers.put("Access-Control-Max-Age", "86400");
            response.put("headers", headers);
        } catch (Exception ignored) {}
        return response;
    }

    private static JSONObject errorResponse(int id, String url, Exception error) {
        JSONObject response = responseJson(id, 502, url, "*", false);
        try {
            response.put("error", error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName());
        } catch (Exception ignored) {}
        return response;
    }

    private static void resolve(
            @NonNull RNCWebView webView,
            int callId,
            @NonNull JSONObject response,
            byte[] binaryMessage
    ) {
        webView.post(() -> {
            if (binaryMessage != null) {
                postBinary(webView, binaryMessage);
            }
            webView.evaluateJavascriptWithFallback(
                    "window.flutter_inappwebview&&window.flutter_inappwebview.__rncBridgeResolve(" +
                            callId + ",true," + response + ");true;"
            );
        });
    }

    private static void postBinary(@NonNull RNCWebView webView, byte[] bytes) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) {
            WebViewCompat.postWebMessage(webView, new WebMessageCompat(bytes), Uri.EMPTY);
            return;
        }
        String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
        webView.evaluateJavascriptWithFallback(
                "(function(){var r=atob(" + JSONObject.quote(base64) + ");" +
                        "var b=new Uint8Array(r.length);for(var i=0;i<r.length;i++)b[i]=r.charCodeAt(i);" +
                        "window.dispatchEvent(new MessageEvent('message',{data:b.buffer}));})();true;"
        );
    }

    private static byte[] withRequestId(int id, byte[] body) {
        ByteBuffer output = ByteBuffer.allocate(body.length + 4).order(ByteOrder.BIG_ENDIAN);
        output.putInt(id);
        output.put(body);
        return output.array();
    }

    private static boolean isAllowed(String host, String scheme, Set<String> rules) {
        if (!("https".equals(scheme) || ("http".equals(scheme) &&
                ("localhost".equals(host) || "127.0.0.1".equals(host))))) return false;
        String normalized = host.toLowerCase(Locale.US);
        for (String rawRule : rules) {
            String rule = rawRule.toLowerCase(Locale.US).trim();
            if ("*".equals(rule) || normalized.equals(rule)) return true;
            if (rule.startsWith("*.") &&
                    (normalized.equals(rule.substring(2)) || normalized.endsWith(rule.substring(1)))) return true;
        }
        return false;
    }

    private static boolean isYoutubeHost(String host) {
        String normalized = host.toLowerCase(Locale.US);
        return "youtube.com".equals(normalized) || normalized.endsWith(".youtube.com");
    }

    private static boolean isUnsafeHeader(String name) {
        return "host".equalsIgnoreCase(name) || "content-length".equalsIgnoreCase(name) ||
                "connection".equalsIgnoreCase(name);
    }

    private static void applyEncodedHeaders(String encoded, Request.Builder builder) {
        if (encoded == null || encoded.isEmpty()) return;
        try {
            Object value = new org.json.JSONTokener(encoded).nextValue();
            if (value instanceof JSONObject) {
                JSONObject object = (JSONObject) value;
                Iterator<String> keys = object.keys();
                while (keys.hasNext()) {
                    String name = keys.next();
                    if (!isUnsafeHeader(name)) builder.header(name, object.optString(name));
                }
            } else if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                for (int index = 0; index < array.length(); index++) {
                    JSONArray pair = array.optJSONArray(index);
                    if (pair != null && pair.length() >= 2 && !isUnsafeHeader(pair.optString(0))) {
                        builder.header(pair.optString(0), pair.optString(1));
                        continue;
                    }
                    JSONObject object = array.optJSONObject(index);
                    if (object != null) {
                        Iterator<String> keys = object.keys();
                        while (keys.hasNext()) {
                            String name = keys.next();
                            if (!isUnsafeHeader(name)) builder.header(name, object.optString(name));
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private static boolean isText(String contentType) {
        return contentType.startsWith("text/") || contentType.contains("json") ||
                contentType.contains("xml") || contentType.contains("javascript");
    }

    private static byte[] decodeContent(byte[] bytes, String contentEncoding) throws IOException {
        if (bytes.length == 0 || contentEncoding.isEmpty() || "identity".equals(contentEncoding)) {
            return bytes;
        }
        InputStream stream;
        if (contentEncoding.contains("gzip")) {
            stream = new GZIPInputStream(new ByteArrayInputStream(bytes));
        } else if (contentEncoding.contains("deflate")) {
            stream = new InflaterInputStream(new ByteArrayInputStream(bytes));
        } else {
            return bytes;
        }
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new IOException("Decoded proxy response is too large.");
                }
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }


    private static String decodeText(byte[] bytes, String contentType) {
        String charsetName = null;
        for (String part : contentType.split(";")) {
            String trimmed = part.trim();
            if (trimmed.toLowerCase(Locale.US).startsWith("charset=")) {
                charsetName = trimmed.substring(8).replace("\"", "").replace("'", "").trim();
                break;
            }
        }
        try {
            return new String(bytes, charsetName == null || charsetName.isEmpty()
                    ? StandardCharsets.UTF_8
                    : Charset.forName(charsetName));
        } catch (Exception ignored) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }
}
