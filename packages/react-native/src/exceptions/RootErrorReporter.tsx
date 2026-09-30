/**
 * Soft-then-fatal root reporter for render errors `Bugsee.wrap` mounts around
 * the app root (R8).
 *
 * Sequence React records for an uncaught render error under this boundary:
 * 1. React hands the caught error to RN's `onCaughtError` (soft, non-fatal).
 * 2. This component reports it as unhandled (when capture is on and the value
 *    was not already claimed), renders nothing while that report is in flight,
 *    then rethrows the same error from `render`.
 * 3. With no boundary above, React's `onUncaughtError` runs RN's fatal path.
 *
 * On RN 0.81+ an uncaught render error never passes through `ErrorUtils`;
 * React calls `onUncaughtError` → `ExceptionsManager.handleException(error, true)`
 * directly. Internal: not exported from `src/index.ts`.
 */
import React from 'react';
import type { ReactNode } from 'react';
import { isExceptionCaptureEnabled } from './handlers';
import { markReported, reportUnhandled } from './report';

interface RootErrorReporterState {
  phase: 'ok' | 'reporting' | 'rethrow';
  error: unknown;
}

export class RootErrorReporter extends React.Component<
  { children?: React.ReactNode },
  RootErrorReporterState
> {
  // Stryker disable next-line ObjectLiteral,StringLiteral -- initial phase 'ok'; emptying or "" still falls through to children the same way
  override state: RootErrorReporterState = {
    phase: 'ok',
    error: undefined,
  };

  static getDerivedStateFromError(error: unknown): Partial<RootErrorReporterState> {
    return { phase: 'reporting', error };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    const componentStack = info.componentStack ?? undefined;

    if (isExceptionCaptureEnabled() && markReported(error)) {
      void reportUnhandled(error, { componentStack }).finally(() => {
        this.setState({ phase: 'rethrow' });
      });
      return;
    }
    this.setState({ phase: 'rethrow' });
  }

  override render(): ReactNode {
    if (this.state.phase === 'rethrow') {
      throw this.state.error;
    }
    if (this.state.phase === 'reporting') {
      return null;
    }
    return this.props.children ?? null;
  }
}
