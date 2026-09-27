import { JavaScriptRequests, serializeJavaScriptArguments } from './JavaScriptRequests';
import { Platform, TurboModuleRegistry } from 'react-native';
import type { HeadlessEvent, Spec } from './NativeRNCWebViewModule';
import {
  buildHandlerResolutionScript,
  buildInAppWebViewBridgeBootstrap,
  parseInAppWebViewBridgeEnvelope,
  type CallAsyncJavaScriptOptions,
  type JavaScriptEvaluationOptions,
  type InAppWebViewJavaScriptHandlers,
} from './InAppWebViewBridge';

export type HeadlessWebViewSize = Readonly<{ width: number; height: number }>;
export type HeadlessWebViewSource = Readonly<{
  uri: string;
  headers?: Readonly<Record<string, string>>;
}>;
export type HeadlessWebViewEvent = Readonly<{
  url: string;
  title?: string;
  progress?: number;
  data?: string;
  code?: number;
  description?: string;
  statusCode?: number;
  isMainFrame?: boolean;
  didCrash?: boolean;
}>;
export type HeadlessWebViewOptions = Readonly<{
  source: HeadlessWebViewSource;
  /** Logical pixels; -1 means the size of the hosting window. Defaults to 1 x 1. */
  initialSize?: HeadlessWebViewSize;
  userAgent?: string;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  cacheEnabled?: boolean;
  sharedCookiesEnabled?: boolean;
  thirdPartyCookiesEnabled?: boolean;
  allowsInlineMediaPlayback?: boolean;
  mediaPlaybackRequiresUserAction?: boolean;
  webviewDebuggingEnabled?: boolean;
  messagingOriginRules?: readonly string[];
  injectedJavaScriptBeforeContentLoaded?: string;
  injectedJavaScript?: string;
  inAppWebViewJavaScriptHandlers?: InAppWebViewJavaScriptHandlers;
  onWebViewCreated?: (controller: HeadlessWebView) => void;
  onLoadStart?: (event: HeadlessWebViewEvent) => void;
  onLoadStop?: (event: HeadlessWebViewEvent) => void;
  onProgressChanged?: (event: HeadlessWebViewEvent) => void;
  onReceivedError?: (event: HeadlessWebViewEvent) => void;
  onReceivedHttpError?: (event: HeadlessWebViewEvent) => void;
  onMessage?: (event: HeadlessWebViewEvent) => void;
  onProcessTerminated?: (event: HeadlessWebViewEvent) => void;
}>;

let sequence = 0;

// Keep the ordinary WebView export usable on platforms without this native module.
function nativeModule(): Spec {
  return TurboModuleRegistry.getEnforcing<Spec>('RNCWebViewModule');
}

/** A native-owned, hidden WebView. No mounted React component is required. */
export class HeadlessWebView {
  private id?: string;
  private running = false;
  private operations: Promise<void> = Promise.resolve();
  private subscription?: { remove(): void };
  private navigation = 0;
  private handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();
  private requests = new JavaScriptRequests();

  constructor(private readonly options: HeadlessWebViewOptions) {}

  /** Registers a page-callable handler after creation, like Flutter's controller API. */
  addJavaScriptHandler(
    name: string,
    callback: (...args: unknown[]) => unknown | Promise<unknown>,
  ): void {
    this.handlers.set(name, callback);
  }

  removeJavaScriptHandler(name: string): void {
    this.handlers.delete(name);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Resolves after creation and starting the initial load, not after page readiness. */
  run(): Promise<void> {
    return this.enqueue(async () => {
      if (this.running) return;
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
        throw new Error('HeadlessWebView supports iOS and Android.');
      }
      const native = nativeModule();
      if (!native.createHeadless || !native.onHeadlessEvent) {
        throw new Error('Rebuild the native app to install HeadlessWebView support.');
      }
      HeadlessWebView.validateSize(this.options.initialSize ?? { width: 1, height: 1 });
      sequence += 1;
      const id = `headless-${Date.now()}-${sequence}`;
      const bootstrap = buildInAppWebViewBridgeBootstrap();
      const {
        onWebViewCreated,
        onLoadStart,
        onLoadStop,
        onProgressChanged,
        onReceivedError,
        onReceivedHttpError,
        onMessage,
        onProcessTerminated,
        inAppWebViewJavaScriptHandlers,
        ...settings
      } = this.options;
      // Functions stay in JS; only native configuration crosses the module boundary.
      const config = JSON.stringify({
        ...settings,
        injectedJavaScriptBeforeContentLoaded: `${bootstrap}\n${settings.injectedJavaScriptBeforeContentLoaded ?? ''}\ntrue;`,
        injectedJavaScript: `${bootstrap}\n${settings.injectedJavaScript ?? ''}\ntrue;`,
      });
      this.id = id;
      try {
        this.subscription = native.onHeadlessEvent((event) => this.onEvent(event));
        await native.createHeadless(id, config);
        this.running = true;
        onWebViewCreated?.(this);
        await this.loadUrl(this.options.source);
      } catch (error) {
        this.reset();
        await native.disposeHeadless(id).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Safe to call while run() is pending or more than once. */
  dispose(): Promise<void> {
    return this.enqueue(async () => {
      const id = this.id;
      if (!id) return;
      this.reset();
      await nativeModule().disposeHeadless(id);
    });
  }

  async getSize(): Promise<HeadlessWebViewSize> {
    return JSON.parse(await this.command('getSize')) as HeadlessWebViewSize;
  }
  async setSize(size: HeadlessWebViewSize): Promise<void> {
    HeadlessWebView.validateSize(size);
    await this.command('setSize', size);
  }
  async loadUrl(source: HeadlessWebViewSource): Promise<void> {
    await this.command('load', source);
  }
  async reload(): Promise<void> {
    await this.command('reload');
  }
  async stopLoading(): Promise<void> {
    await this.command('stop');
  }
  async injectJavaScript(script: string): Promise<void> {
    await this.command('inject', { script });
  }

  evaluateJavascript<T = unknown>(
    source: string,
    options: JavaScriptEvaluationOptions = {},
  ): Promise<T> {
    return this.executeJavaScript<T>(source, false, options);
  }

  callAsyncJavaScript<T = unknown>(
    body: string,
    options: CallAsyncJavaScriptOptions = {},
  ): Promise<T> {
    return this.executeJavaScript<T>(body, true, options);
  }

  private executeJavaScript<T>(
    source: string,
    asynchronous: boolean,
    options: CallAsyncJavaScriptOptions,
  ): Promise<T> {
    if (!this.running) return Promise.reject(new Error('HeadlessWebView is not running.'));
    let args: string;
    try {
      args = serializeJavaScriptArguments(options.arguments);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.requests.run<T>(async (id) => {
      await this.command('executeJavaScript', { id, source, arguments: args, asynchronous });
    }, options);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => undefined);
    return result;
  }
  private command(command: string, payload: unknown = {}): Promise<string> {
    if (!this.id || !this.running)
      return Promise.reject(new Error('HeadlessWebView is not running.'));
    return nativeModule().commandHeadless(this.id, command, JSON.stringify(payload));
  }
  private static validateSize(size: HeadlessWebViewSize): void {
    if (
      [size.width, size.height].some(
        (value) => !Number.isFinite(value) || (value < 0 && value !== -1),
      )
    ) {
      throw new Error('HeadlessWebView size must be non-negative, or -1 for the window size.');
    }
  }
  private cancelRequests(reason: string): void {
    this.requests.cancel(reason);
  }
  private reset(): void {
    this.running = false;
    this.id = undefined;
    this.navigation += 1;
    this.subscription?.remove();
    this.subscription = undefined;
    this.cancelRequests('HeadlessWebView was disposed.');
  }
  private onEvent(event: HeadlessEvent): void {
    if (event.id !== this.id) return;
    const data = JSON.parse(event.data) as HeadlessWebViewEvent;
    switch (event.type) {
      case 'loadStart':
        this.navigation += 1;
        this.cancelRequests('HeadlessWebView navigated to another document.');
        this.options.onLoadStart?.(data);
        break;
      case 'loadStop':
        this.options.onLoadStop?.(data);
        break;
      case 'progress':
        this.options.onProgressChanged?.(data);
        break;
      case 'error':
        this.options.onReceivedError?.(data);
        break;
      case 'httpError':
        this.options.onReceivedHttpError?.(data);
        break;
      case 'terminated':
        this.reset();
        this.options.onProcessTerminated?.(data);
        break;
      case 'disposed':
        this.reset();
        break;
      case 'message':
        this.onMessage(data);
        break;
      default:
        break;
    }
  }
  private onMessage(event: HeadlessWebViewEvent): void {
    const envelope = parseInAppWebViewBridgeEnvelope(event.data ?? '');
    if (!envelope) {
      this.options.onMessage?.(event);
      return;
    }
    if (envelope.type === 'async-result') {
      this.requests.finish(envelope.id, envelope.ok, envelope.ok ? envelope.value : envelope.error);
      return;
    }
    const id = this.id;
    const navigation = this.navigation;
    const handler =
      this.handlers.get(envelope.handlerName) ??
      this.options.inAppWebViewJavaScriptHandlers?.[envelope.handlerName];
    const respond = (ok: boolean, value: unknown) => {
      if (id !== this.id || navigation !== this.navigation || !this.running) return;
      this.injectJavaScript(
        buildHandlerResolutionScript(envelope.id, ok, value, envelope.documentId),
      ).catch(() => undefined);
    };
    Promise.resolve()
      .then(() => {
        if (!handler)
          throw new Error(`JavaScript handler '${envelope.handlerName}' is not registered.`);
        return handler(...envelope.args);
      })
      .then(
        (value) => respond(true, value),
        (error) => respond(false, String(error)),
      );
  }
}
