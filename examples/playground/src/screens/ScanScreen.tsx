import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useSession } from '../session/SessionContext';
import { parseQrPayload } from '../session/token';

export default function ScanScreen() {
  const [permission, request] = useCameraPermissions();
  const router = useRouter();
  const { setPendingToken } = useSession();
  const handled = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onScan = ({ data }: { data: string }) => {
    if (handled.current) return;
    const r = parseQrPayload(data);
    if (r.ok) {
      handled.current = true;
      setPendingToken(r.token);
      router.back();
      return;
    }
    setError(r.error);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setError(null), 2000);
  };

  return (
    <View style={styles.root}>
      {permission?.granted ? (
        <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => request()} style={styles.grant}>
          <Text style={styles.grantText}>Grant camera access</Text>
        </Pressable>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.hint}>Get this code from your app's settings on the Bugsee dashboard.</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  camera: { flex: 1 },
  grant: { margin: 16, padding: 14, borderRadius: 8, backgroundColor: '#175cd3', alignItems: 'center' },
  grantText: { color: '#fff', fontWeight: '600' },
  error: { color: '#b42318', textAlign: 'center', padding: 8 },
  hint: { padding: 16, textAlign: 'center', color: '#475467' },
});
