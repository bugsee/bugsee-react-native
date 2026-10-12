import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { NotLaunchedBanner } from './Banner';
import { ResultLog, ResultLogContext } from './ResultLog';

export function Screen({ title, banner = true, children }: { title: string; banner?: boolean; children?: ReactNode }) {
  const [lines, setLines] = useState<string[]>([]);
  const add = useCallback(
    (l: string) => setLines((p) => [`${new Date().toISOString().slice(11, 23)} ${l}`, ...p].slice(0, 50)),
    [],
  );
  return (
    <ResultLogContext.Provider value={add}>
      <ScrollView contentContainerStyle={styles.content} accessibilityLabel={title}>
        {banner ? <NotLaunchedBanner /> : null}
        {children}
        <ResultLog lines={lines} />
      </ScrollView>
    </ResultLogContext.Provider>
  );
}
const styles = StyleSheet.create({ content: { padding: 16 } });
