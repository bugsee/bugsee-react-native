import Bugsee, { SpanStatus } from '@bugsee/react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { DEMO, postJson } from '../../demoApi';
import { stepSpan } from '../../shop/flow';
import { CapturedNote } from '../../ui/CapturedNote';
import { Screen } from '../../ui/Screen';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('shopper@example.com');
  const [password, setPassword] = useState('hunter2');
  const [remember, setRemember] = useState(false);

  const submit = async () => {
    const s = stepSpan('sign-in');
    await postJson(DEMO.ECHO, { email, password });
    if (remember) {
      Bugsee.setUserIdentifier(email);
    }
    s.finish(SpanStatus.OK);
    router.push('/shop/products');
  };

  return (
    <Screen title="Sign in">
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        accessibilityLabel="Email"
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        accessibilityLabel="Password"
      />
      <View style={styles.row}>
        <Text>Remember me</Text>
        <Switch value={remember} onValueChange={setRemember} accessibilityLabel="Remember me" />
      </View>
      <Button title="Sign in" onPress={submit} />
      <CapturedNote
        lines={[
          'Password masked in video with no extra code',
          'Request body shows "password":"***"',
          'User id set if Remember me',
        ]}
      />
    </Screen>
  );
}
const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: '#bbb', borderRadius: 6, padding: 10, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
});
