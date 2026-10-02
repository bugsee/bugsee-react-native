import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * The native surface. Codegen turns this into the Java and ObjC++ specs.
 *
 * The TurboModule is `BugseeFeedbackModule`, not `BugseeFeedback`: on iOS
 * `NSClassFromString(@"BugseeFeedback")` is the SDK's own class, the same
 * collision the core module has with `Bugsee`.
 *
 * `messagesJson` is a JSON array of strings. A ReadableArray in the event
 * payload is a different codegen shape on the two platforms; one string is
 * the same shape on both.
 */
export interface Spec extends TurboModule {
  showFeedbackUI(): void;
  /** `null` clears the greeting. */
  setGreeting(greeting: string | null): void;
  /**
   * `true` installs the native listener that emits the two events below.
   * `false` clears it. JS subscribes to the events before passing `true`.
   */
  setListenerEnabled(enabled: boolean): void;
  /**
   * One feedback color. `name` is already the platform's native key
   * (`Feedback::IncomingBubbleColor` on Android, `feedbackIncomingBubbleColor`
   * on iOS). Components are 0–255.
   */
  setAppearanceColor(name: string, r: number, g: number, b: number, a: number): void;

  readonly onNewMessagesReceived: EventEmitter<{ messagesJson: string }>;
  readonly onNewMessageSent: EventEmitter<{ message: string }>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('BugseeFeedbackModule');
