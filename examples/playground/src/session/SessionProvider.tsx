import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Bugsee, { Status } from '@bugsee/react-native';
import type { LifecycleEvent } from '@bugsee/react-native';
import { DEFAULT_CONFIG, loadConfig, saveConfig, setConfigPatcher } from './config';
import type { SavedConfig } from './config';
import { launchWith, relaunchWith } from './launch';
import { SessionContext } from './SessionContext';
import type { Session } from './SessionContext';
import { isAppToken } from './token';

const MAX_LIFECYCLE = 100;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** One lifecycle log line: the event name, plus the report id for the events that carry one. */
export const describeLifecycleEvent = (e: LifecycleEvent) => (e.reportId ? `${e.name} (${e.reportId})` : e.name);

export function SessionProvider({ children }: { children?: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfigState] = useState<SavedConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<Status>(Status.Stopped);
  const [lifecycle, setLifecycle] = useState<Session['lifecycle']>([]);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  // Always the latest config, so launch() right after setConfig() sees the new value.
  const configRef = useRef(config);

  const push = useCallback((event: string) => {
    setLifecycle((p) => [...p, { at: new Date().toISOString().slice(11, 23), event }].slice(-MAX_LIFECYCLE));
  }, []);
  const refreshStatus = useCallback(async () => {
    try { setStatus(await Bugsee.getStatus()); } catch { /* keep the previous status */ }
  }, []);

  useEffect(() => {
    let alive = true;
    const subs: { remove(): void }[] = [];
    (async () => {
      const loaded = await loadConfig();
      if (!alive) return;
      configRef.current = loaded;
      setConfigState(loaded);
      subs.push(
        Bugsee.onLifecycleEvent((e) => push(describeLifecycleEvent(e))),
        Bugsee.onStatusChange((s) => setStatus(s)),
      );
      if (loaded.autoLaunch && isAppToken(loaded.token)) {
        try { await launchWith(loaded); } catch (e) { push(`launch failed: ${msg(e)}`); }
      }
      await refreshStatus();
      if (alive) setReady(true);
    })();
    return () => { alive = false; subs.forEach((s) => s.remove()); };
  }, [push, refreshStatus]);

  const setConfig = useCallback(async (c: SavedConfig) => {
    configRef.current = c;
    setConfigState(c);
    await saveConfig(c);
  }, []);
  useEffect(() => setConfigPatcher((p) => setConfig({ ...configRef.current, ...p })), [setConfig]);

  const run = useCallback(async (fn: () => Promise<boolean>) => {
    try { return await fn(); } finally { await refreshStatus(); }
  }, [refreshStatus]);

  const launch = useCallback(() => run(async () => {
    let ok: boolean;
    try { ok = await launchWith(configRef.current); } catch (e) { push(`launch failed: ${msg(e)}`); throw e; }
    // Persisted only after a successful launch, so a failed first launch shows Setup again on restart.
    if (ok && !configRef.current.everLaunched) await setConfig({ ...configRef.current, everLaunched: true });
    return ok;
  }), [run, setConfig, push]);
  const relaunch = useCallback(
    () => run(() => relaunchWith(configRef.current)),
    [run],
  );
  const stop = useCallback(() => run(() => Bugsee.stop()), [run]);

  const value = useMemo<Session>(
    () => ({
      ready, config, setConfig, status, lifecycle, note: push, launch, relaunch, stop, pendingToken, setPendingToken,
    }),
    [ready, config, setConfig, status, lifecycle, push, launch, relaunch, stop, pendingToken],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
