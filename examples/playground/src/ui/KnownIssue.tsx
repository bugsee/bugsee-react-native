import { Linking, Platform, StyleSheet, Text } from 'react-native';
import { KNOWN_ISSUES } from './knownIssues';
import type { KnownIssueId } from './knownIssues';

export function KnownIssue({ id }: { id: KnownIssueId }) {
  const issue = KNOWN_ISSUES[id];
  if (issue === undefined || Platform.OS !== issue.platform) return null;
  return (
    <Text accessibilityRole="link" style={styles.link} onPress={() => void Linking.openURL(issue.url)}>
      {`⚠ Known issue: ${issue.title}`}
    </Text>
  );
}
const styles = StyleSheet.create({ link: { fontSize: 12, color: '#b54708', textDecorationLine: 'underline', marginTop: 4 } });
