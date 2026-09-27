import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import { Double, EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

export type HeadlessEvent = Readonly<{ id: string; type: string; data: string }>;

export interface Spec extends TurboModule {
  shouldStartLoadWithLockIdentifier(shouldStart: boolean, lockIdentifier: Double): void;
  createHeadless(id: string, options: string): Promise<void>;
  disposeHeadless(id: string): Promise<void>;
  commandHeadless(id: string, command: string, payload: string): Promise<string>;
  readonly onHeadlessEvent: EventEmitter<HeadlessEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNCWebViewModule');
