import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Image, View, ImageSourcePropType, HostComponent } from 'react-native';
import invariant from 'invariant';

import RNCWebView, { Commands, NativeProps } from './RNCWebViewNativeComponent';
import RNCWebViewModule from './NativeRNCWebViewModule';

import {
  defaultOriginWhitelist,
  defaultRenderError,
  defaultRenderLoading,
  useWebViewLogic,
} from './WebViewShared';
import { IOSWebViewProps, DecelerationRateConstant, WebViewSourceUri } from './WebViewTypes';
import type { WebViewMessageEvent } from './WebViewTypes';
import {
  buildHandlerResolutionScript,
  buildInAppWebViewBridgeBootstrap,
  parseInAppWebViewBridgeEnvelope,
  type CallAsyncJavaScriptOptions,
  type JavaScriptEvaluationOptions,
  type InAppWebViewJavaScriptHandler,
  type PostWebMessage,
} from './InAppWebViewBridge';

import { JavaScriptRequests, serializeJavaScriptArguments } from './JavaScriptRequests';
import styles from './WebView.styles';

const resolveAssetSource = (source: ImageSourcePropType) => Image.resolveAssetSource(source);
const processDecelerationRate = (
  decelerationRate: DecelerationRateConstant | number | undefined,
) => {
  let newDecelerationRate = decelerationRate;
  if (newDecelerationRate === 'normal') {
    newDecelerationRate = 0.998;
  } else if (newDecelerationRate === 'fast') {
    newDecelerationRate = 0.99;
  }
  return newDecelerationRate;
};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-constraint
const useWarnIfChanges = <T extends unknown>(value: T, name: string) => {
  const ref = useRef(value);
  useEffect(() => {
    if (ref.current !== value) {
      console.warn(`Changes to property ${name} do nothing after the initial render.`);
      ref.current = value;
    }
  }, [value, name]);
};

const WebViewComponent = forwardRef<unknown, IOSWebViewProps>(
  (
    {
      fraudulentWebsiteWarningEnabled = true,
      javaScriptEnabled = true,
      cacheEnabled = true,
      originWhitelist = defaultOriginWhitelist,
      useSharedProcessPool = true,
      textInteractionEnabled = true,
      injectedJavaScript,
      injectedJavaScriptBeforeContentLoaded,
      injectedJavaScriptForMainFrameOnly = true,
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly = true,
      injectedJavaScriptObject,
      startInLoadingState,
      onNavigationStateChange,
      onLoadStart,
      onError,
      onLoad,
      onLoadEnd,
      onLoadProgress,
      onContentProcessDidTerminate: onContentProcessDidTerminateProp,
      onFileDownload,
      onHttpError: onHttpErrorProp,
      onMessage: onMessageProp,
      inAppWebViewJavaScriptHandlers,
      messagingOriginRules,
      nativeProxyEnabled,
      nativeProxyAllowedHosts,
      onOpenWindow: onOpenWindowProp,
      renderLoading,
      renderError,
      style,
      containerStyle,
      source,
      nativeConfig,
      allowsInlineMediaPlayback,
      allowsPictureInPictureMediaPlayback = true,
      allowsAirPlayForMediaPlayback,
      mediaPlaybackRequiresUserAction,
      dataDetectorTypes,
      incognito,
      decelerationRate: decelerationRateProp,
      onShouldStartLoadWithRequest: onShouldStartLoadWithRequestProp,
      removeIosKeyboardObserver,
      ...otherProps
    },
    ref,
  ) => {
    const webViewRef = useRef<React.ComponentRef<HostComponent<NativeProps>> | null>(null);
    const dynamicHandlers = useRef(new Map<string, InAppWebViewJavaScriptHandler>());
    const navigation = useRef(0);
    const asyncRequests = useRef(new JavaScriptRequests());
    const cancelRequests = useCallback((reason: string) => {
      navigation.current += 1;
      asyncRequests.current.cancel(reason);
    }, []);
    const execute = useCallback(
      <T,>(
        source: string,
        asynchronous: boolean,
        options: CallAsyncJavaScriptOptions = {},
      ): Promise<T> => {
        const view = webViewRef.current;
        if (!view) return Promise.reject(new Error('WebView is not attached.'));
        let args: string;
        try {
          args = serializeJavaScriptArguments(options.arguments);
        } catch (error) {
          return Promise.reject(error);
        }
        return asyncRequests.current.run<T>(
          (id) => Commands.executeJavaScript(view, id, source, args, asynchronous),
          options,
        );
      },
      [],
    );
    const bridgeOnMessage = useCallback(
      (event: WebViewMessageEvent) => {
        const envelope = parseInAppWebViewBridgeEnvelope(event.nativeEvent.data);
        if (!envelope) {
          onMessageProp?.(event);
          return;
        }
        if (envelope.type === 'async-result') {
          asyncRequests.current.finish(
            envelope.id,
            envelope.ok,
            envelope.ok ? envelope.value : envelope.error,
          );
          return;
        }
        const document = navigation.current;
        const handler =
          dynamicHandlers.current.get(envelope.handlerName) ??
          inAppWebViewJavaScriptHandlers?.[envelope.handlerName];
        if (!handler) {
          if (webViewRef.current) {
            Commands.injectJavaScript(
              webViewRef.current,
              buildHandlerResolutionScript(
                envelope.id,
                false,
                `JavaScript handler '${envelope.handlerName}' is not registered.`,
                envelope.documentId,
              ),
            );
          }
          return;
        }
        Promise.resolve()
          .then(() => handler(...envelope.args))
          .then(
            (value) => {
              if (webViewRef.current && document === navigation.current) {
                Commands.injectJavaScript(
                  webViewRef.current,
                  buildHandlerResolutionScript(envelope.id, true, value, envelope.documentId),
                );
              }
            },
            (error) => {
              if (webViewRef.current && document === navigation.current) {
                Commands.injectJavaScript(
                  webViewRef.current,
                  buildHandlerResolutionScript(
                    envelope.id,
                    false,
                    error instanceof Error ? error.message : String(error),
                    envelope.documentId,
                  ),
                );
              }
            },
          );
      },
      [inAppWebViewJavaScriptHandlers, onMessageProp],
    );

    useEffect(() => () => cancelRequests('WebView was unmounted.'), [cancelRequests]);

    const onShouldStartLoadWithRequestCallback = useCallback(
      (shouldStart: boolean, _url: string, lockIdentifier = 0) => {
        RNCWebViewModule.shouldStartLoadWithLockIdentifier(shouldStart, lockIdentifier);
      },
      [],
    );

    const {
      onLoadingStart,
      onShouldStartLoadWithRequest,
      onMessage,
      viewState,
      setViewState,
      lastErrorEvent,
      onHttpError,
      onLoadingError,
      onLoadingFinish,
      onLoadingProgress,
      onOpenWindow,
      onContentProcessDidTerminate,
    } = useWebViewLogic({
      onNavigationStateChange,
      onLoad,
      onError,
      onHttpErrorProp,
      onLoadEnd,
      onLoadProgress,
      onLoadStart,
      onMessageProp: bridgeOnMessage,
      onOpenWindowProp,
      startInLoadingState,
      originWhitelist,
      onShouldStartLoadWithRequestProp,
      onShouldStartLoadWithRequestCallback,
      onContentProcessDidTerminateProp,
    });

    useImperativeHandle(
      ref,
      () => ({
        addJavaScriptHandler: (name: string, callback: InAppWebViewJavaScriptHandler) => {
          dynamicHandlers.current.set(name, callback);
        },
        removeJavaScriptHandler: (name: string) => {
          dynamicHandlers.current.delete(name);
        },
        goForward: () => webViewRef.current && Commands.goForward(webViewRef.current),
        goBack: () => webViewRef.current && Commands.goBack(webViewRef.current),
        reload: () => {
          setViewState('LOADING');
          if (webViewRef.current) {
            Commands.reload(webViewRef.current);
          }
        },
        stopLoading: () => webViewRef.current && Commands.stopLoading(webViewRef.current),
        postMessage: (data: string) =>
          webViewRef.current && Commands.postMessage(webViewRef.current, data),
        postWebMessage: (message: PostWebMessage) =>
          webViewRef.current &&
          Commands.postWebMessage(
            webViewRef.current,
            message.data,
            message.type ?? 'string',
            message.targetOrigin ?? '',
          ),
        evaluateJavascript: <T,>(source: string, options: JavaScriptEvaluationOptions = {}) =>
          execute<T>(source, false, options),
        callAsyncJavaScript: <T,>(body: string, options: CallAsyncJavaScriptOptions = {}) =>
          execute<T>(body, true, options),
        injectJavaScript: (data: string) =>
          webViewRef.current && Commands.injectJavaScript(webViewRef.current, data),
        requestFocus: () => webViewRef.current && Commands.requestFocus(webViewRef.current),
        clearCache: (includeDiskFiles: boolean) =>
          webViewRef.current && Commands.clearCache(webViewRef.current, includeDiskFiles),
      }),
      [setViewState, webViewRef, execute],
    );

    useWarnIfChanges(allowsInlineMediaPlayback, 'allowsInlineMediaPlayback');
    useWarnIfChanges(allowsPictureInPictureMediaPlayback, 'allowsPictureInPictureMediaPlayback');
    useWarnIfChanges(allowsAirPlayForMediaPlayback, 'allowsAirPlayForMediaPlayback');
    useWarnIfChanges(incognito, 'incognito');
    useWarnIfChanges(mediaPlaybackRequiresUserAction, 'mediaPlaybackRequiresUserAction');
    useWarnIfChanges(dataDetectorTypes, 'dataDetectorTypes');
    useWarnIfChanges(removeIosKeyboardObserver, 'removeIosKeyboardObserver');

    let otherView = null;
    if (viewState === 'LOADING') {
      otherView = (renderLoading || defaultRenderLoading)();
    } else if (viewState === 'ERROR') {
      invariant(lastErrorEvent != null, 'lastErrorEvent expected to be non-null');
      otherView = (renderError || defaultRenderError)(
        lastErrorEvent?.domain,
        lastErrorEvent?.code ?? 0,
        lastErrorEvent?.description ?? '',
      );
    }

    const webViewStyles = [styles.container, styles.webView, style];
    const webViewContainerStyle = [styles.container, containerStyle];

    const decelerationRate = processDecelerationRate(decelerationRateProp);

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const NativeWebView = (nativeConfig?.component as typeof RNCWebView | undefined) || RNCWebView;

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const sourceResolved = resolveAssetSource(source as ImageSourcePropType);
    const newSource =
      typeof sourceResolved === 'object'
        ? Object.entries(sourceResolved as WebViewSourceUri).reduce(
            (prev, [currKey, currValue]) => {
              return {
                ...prev,
                [currKey]:
                  currKey === 'headers' && currValue && typeof currValue === 'object'
                    ? Object.entries(currValue).map(([key, value]) => {
                        return {
                          name: key,
                          value,
                        };
                      })
                    : currValue,
              };
            },
            {},
          )
        : sourceResolved;

    const webView = (
      <NativeWebView
        key="webViewKey"
        {...otherProps}
        fraudulentWebsiteWarningEnabled={fraudulentWebsiteWarningEnabled}
        javaScriptEnabled={javaScriptEnabled}
        cacheEnabled={cacheEnabled}
        useSharedProcessPool={useSharedProcessPool}
        textInteractionEnabled={textInteractionEnabled}
        decelerationRate={decelerationRate}
        messagingEnabled={true}
        messagingModuleName="" // android ONLY
        messagingOriginRules={messagingOriginRules}
        nativeProxyEnabled={nativeProxyEnabled}
        nativeProxyAllowedHosts={nativeProxyAllowedHosts}
        onLoadingError={onLoadingError}
        onLoadingFinish={onLoadingFinish}
        onLoadingProgress={onLoadingProgress}
        onFileDownload={onFileDownload}
        onLoadingStart={(event) => {
          cancelRequests('WebView navigated to another document.');
          onLoadingStart(event);
        }}
        onHttpError={onHttpError}
        onMessage={onMessage}
        onOpenWindow={onOpenWindowProp && onOpenWindow}
        hasOnOpenWindowEvent={onOpenWindowProp !== undefined}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onContentProcessDidTerminate={(event) => {
          cancelRequests('WebView process terminated.');
          onContentProcessDidTerminate(event);
        }}
        injectedJavaScript={`${buildInAppWebViewBridgeBootstrap()}\n${injectedJavaScript ?? ''}`}
        injectedJavaScriptBeforeContentLoaded={`${buildInAppWebViewBridgeBootstrap()}\n${injectedJavaScriptBeforeContentLoaded ?? ''}`}
        injectedJavaScriptForMainFrameOnly={injectedJavaScriptForMainFrameOnly}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        }
        injectedJavaScriptObject={JSON.stringify(injectedJavaScriptObject)}
        dataDetectorTypes={
          !dataDetectorTypes || Array.isArray(dataDetectorTypes)
            ? dataDetectorTypes
            : [dataDetectorTypes]
        }
        allowsAirPlayForMediaPlayback={allowsAirPlayForMediaPlayback}
        allowsInlineMediaPlayback={allowsInlineMediaPlayback}
        allowsPictureInPictureMediaPlayback={allowsPictureInPictureMediaPlayback}
        incognito={incognito}
        mediaPlaybackRequiresUserAction={mediaPlaybackRequiresUserAction}
        removeIosKeyboardObserver={removeIosKeyboardObserver}
        newSource={newSource}
        style={webViewStyles}
        hasOnFileDownload={!!onFileDownload}
        ref={webViewRef}
        {...nativeConfig?.props}
      />
    );

    return (
      <View style={webViewContainerStyle}>
        {webView}
        {otherView}
      </View>
    );
  },
);

// no native implementation for iOS, depends only on permissions
const isFileUploadSupported: () => Promise<boolean> = async () => true;

const WebView = Object.assign(WebViewComponent, { isFileUploadSupported });

export default WebView;
