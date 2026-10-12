import { createContext, useContext } from 'react';
import type { Status } from '@bugsee/react-native';
import type { SavedConfig } from './config';

export interface Session {
  ready: boolean;
  config: SavedConfig;
  setConfig(c: SavedConfig): Promise<void>;
  status: Status;
  lifecycle: { at: string; event: string }[];
  launch(): Promise<boolean>;
  relaunch(): Promise<boolean>;
  stop(): Promise<boolean>;
  pendingToken: string | null;
  setPendingToken(t: string | null): void;
}
export const SessionContext = createContext<Session | undefined>(undefined);
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used inside a SessionProvider');
  return s;
}
export const useOptionalSession = (): Session | undefined => useContext(SessionContext);
