import { BugseeSecure } from '@bugsee/react-native';
import { useState } from 'react';
import { Alert, Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { cart, pay, stepSpan } from '../../shop/flow';
import type { PayOutcome } from '../../shop/flow';
import { CapturedNote } from '../../ui/CapturedNote';
import { Screen } from '../../ui/Screen';
import { PLACEHOLDER_COLOR } from '../../ui/placeholder';

const OUTCOMES: { id: PayOutcome; label: string }[] = [
  { id: 'success', label: 'Success' },
  { id: 'declined', label: 'Declined' },
  { id: 'bug', label: 'Bug' },
];

const MESSAGES = { ok: 'Order placed', declined: 'Payment declined', bug: 'Processing…' };

export default function Checkout() {
  const [outcome, setOutcome] = useState<PayOutcome>('success');
  const [toast, setToast] = useState<string | null>(null);

  const submit = async () => {
    const s = stepSpan('checkout');
    setToast(null);
    try {
      const result = await pay(outcome, cart, s);
      const message = MESSAGES[result];
      setToast(message);
      if (result !== 'bug') {
        Alert.alert('Checkout', message);
      }
    } catch (e) {
      setToast(`Payment failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Screen title="Checkout">
      <BugseeSecure>
        <TextInput
          style={styles.input}
          placeholderTextColor={PLACEHOLDER_COLOR}
          placeholder="Card number"
          keyboardType="number-pad"
          accessibilityLabel="Card number"
        />
        <TextInput
          style={styles.input}
          placeholderTextColor={PLACEHOLDER_COLOR}
          placeholder="Expiry (MM/YY)"
          accessibilityLabel="Expiry"
        />
        <TextInput
          style={styles.input}
          placeholderTextColor={PLACEHOLDER_COLOR}
          placeholder="CVV"
          keyboardType="number-pad"
          accessibilityLabel="CVV"
        />
      </BugseeSecure>
      <TextInput
        style={styles.input}
        placeholderTextColor={PLACEHOLDER_COLOR}
        placeholder="Shipping address"
        accessibilityLabel="Shipping address"
      />
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
