/**
 * App-facing error boundary: catches a render error below it, reports it as
 * handled (with the component stack as an extra, never as `error.cause`), and
 * renders a fallback. Children are a `ReactNode` only — 6.x's
 * function-as-children form is not carried.
 */
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ExceptionOptions } from './options';
import { encodeExceptionOptions } from './options';
import { markReported, reportHandled } from './report';

export interface ErrorBoundaryFallbackProps {
  error: unknown;
  componentStack: string | undefined;
  resetError(): void;
}

export interface ErrorBoundaryProps {
  children?: React.ReactNode;
  fallback?: React.ReactElement | ((props: ErrorBoundaryFallbackProps) => React.ReactNode);
  onError?(error: unknown, componentStack: string | undefined): void;
  onReset?(error: unknown, componentStack: string | undefined): void;
  /** Passed to the handled report. */
  options?: ExceptionOptions;
}

interface ErrorBoundaryState {
  error: unknown;
  componentStack?: string;
  caught: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // Stryker disable next-line ObjectLiteral -- initial caught:false/error:undefined; emptying {} still falsy-caught so children render the same
  override state: ErrorBoundaryState = {
    caught: false,
    error: undefined,
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { caught: true, error };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    const componentStack = info.componentStack ?? undefined;
    this.setState({ componentStack });

    // Validate before the claim. reportHandled swallows an encode throw, so a
    // claim made first would drop this report and block every later route.
    let options = this.props.options;
    try {
      encodeExceptionOptions(options);
    } catch (cause) {
      console.warn(
        '[Bugsee] ErrorBoundary options rejected; reporting without options',
        cause,
      );
      options = undefined;
    }
    if (markReported(error)) {
      reportHandled(error, options, { componentStack });
    }
    this.props.onError?.(error, componentStack);
  }

  private resetError = (): void => {
    const { error, componentStack } = this.state;
    this.props.onReset?.(error, componentStack);
    this.setState({ caught: false, error: undefined, componentStack: undefined });
  };

  override render(): ReactNode {
    if (!this.state.caught) {
      return this.props.children ?? null;
    }

    const { fallback } = this.props;
    // Stryker disable next-line ConditionalExpression,BlockStatement -- undefined fallback must return null; falling through returns undefined, which toJSON also treats as null
    if (fallback === undefined) {
      return null;
    }
    if (typeof fallback === 'function') {
      return fallback({
        error: this.state.error,
        componentStack: this.state.componentStack,
        resetError: this.resetError,
      });
    }
    return fallback as ReactElement;
  }
}
