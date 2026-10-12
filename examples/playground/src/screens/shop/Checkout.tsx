import { BugseeSecure } from '@bugsee/react-native';
import { useState } from 'react';
import { Alert, Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { cart, pay, stepSpan } from '../../shop/flow';
import type { PayOutcome } from '../../shop/flow';
import { CapturedNote } from '../../ui/CapturedNote';
import { Screen } from '../../ui/Screen';

const OUTCOMES: { id: PayOutcome; label: string }[] = [
  { id: 'success', label: 'Success' },
  { id: 'declined', label: 'Declined' },
  { id: 'bug', label: 'Bug' },
];

export default function Checkout() {
  const [outcome, setOutcome] = useState<PayOutcome>('success');
  const [toast, setToast] = useState<string | null>(null);

  const submit = async () => {
    const s = stepSpan('checkout');
    const result = await pay(outcome, cart);
    s.finish();
    const message = result === 'ok' ? 'Order placed' : 'Payment declined';
    setToast(message);
    Alert.alert('Checkout', message);
  };

  return (
    <Screen title="Checkout">
      <BugseeSecure>
        <TextInput
          style={styles.input}
          placeholder="Card number"
          keyboardType="number-pad"
          accessibilityLabel="Card number"
        />
        <TextInput style={styles.input} placeholder="Expiry (MM/YY)" accessibilityLabel="Expiry" />
        <TextInput style={styles.input} placeholder="CVV" keyboardType="number-pad" accessibilityLabel="CVV" />
      </BugseeSecure>
      <TextInput style={styles.input} placeholder="Shipping address" accessibilityLabel="Shipping address" />
      <View style={styles.segments}>
        {OUTCOMES.map((o) => (
          <Pressable
            key={o.id}
            style={[styles.segment, outcome === o.id && styles.selected]}
            onPress={() => setOutcome(o.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: outcome === o.id }}
          >
            <Text>{o.label}</Text>
          </Pressable>
        ))}
      </View>
      <Button title="Pay" onPress={submit} />
      {toast ? <Text style={styles.toast}>{toast}</Text> : null}
      <CapturedNote
        lines={[
          'Card fields black in video, address visible',
          'Declined: handled error with labels checkout, payment',
          'Bug: crash at next launch with the whole flow',
        ]}
      />
    </Screen>
  );
}
const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: '#bbb', borderRadius: 6, padding: 10, marginBottom: 10 },
  segments: { flexDirection: 'row', marginBottom: 12 },
  segment: { flex: 1, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: '#bbb' },
  selected: { backgroundColor: '#dbeafe' },
  toast: { marginTop: 8, fontWeight: '600' },
});
