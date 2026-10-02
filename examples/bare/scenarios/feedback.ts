/**
 * Phase 12: present the feedback chat after launch.
 *
 * Sets a greeting and one appearance color that carry the nonce, installs a
 * listener, then calls `showFeedbackUI`. The lines are the later device
 * pass's contract. This scenario does not upload a report.
 */
import {
  appearance,
  setGreeting,
  setListener,
  showFeedbackUI,
} from '@bugsee/react-native-feedback';

export const FEEDBACK_SCENARIOS = ['feedback'] as const;

export type FeedbackScenario = (typeof FEEDBACK_SCENARIOS)[number];

export function isFeedbackScenario(name: string): name is FeedbackScenario {
  return (FEEDBACK_SCENARIOS as readonly string[]).includes(name);
}

export function runFeedbackScenario(nonce: string): void {
  setGreeting(`hello ${nonce}`);
  appearance.backgroundColor = '#112233';
  setListener({
    onNewMessagesReceived(messages) {
      console.log(
        `BUGSEE_E2E feedback received nonce=${nonce} count=${messages.length}`,
      );
    },
    onNewMessageSent(message) {
      console.log(`BUGSEE_E2E feedback sent nonce=${nonce} message=${message}`);
    },
  });
  showFeedbackUI();
  console.log(`BUGSEE_E2E feedback shown nonce=${nonce}`);
}
