import Bugsee, { SpanStatus } from '@bugsee/react-native';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { DemoHttpError, fetchProducts } from '../../demoApi';
import type { Product } from '../../demoApi';
import { stepSpan } from '../../shop/flow';
import { CapturedNote } from '../../ui/CapturedNote';
import { Toggle } from '../../ui/Toggle';

export default function Products() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [source, setSource] = useState<'network' | 'mock'>('network');
  const [flaky, setFlaky] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const attempts = useRef(0);

  const load = useCallback(async () => {
    const n = attempts.current;
    attempts.current += 1;
    setAttempt(attempts.current);
    const s = stepSpan('products');
    setError(null);
    let status: SpanStatus = SpanStatus.OK;
    try {
      const r = await fetchProducts({ flaky, attempt: n });
      setProducts(r.products);
      setSource(r.source);
    } catch (e) {
      status = SpanStatus.Error;
      if (e instanceof DemoHttpError) {
        setError(`Could not load products (HTTP ${e.status})`);
        Bugsee.logException(e, { labels: ['shop', 'products'] });
      } else {
        setError(`Could not load products: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      s.finish(status);
    }
  }, [flaky]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    Bugsee.addBreadcrumb({
      category: 'shop',
      level: 'info',
      message: 'Refreshed products',
      type: 'user',
    });
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const open = (id: number) => {
    Bugsee.event('product_viewed', { id });
    router.push(`/shop/product/${id}`);
  };

  return (
    <FlatList
      data={products}
      keyExtractor={(p) => String(p.id)}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <View>
          <Toggle label="Flaky API (every 3rd load fails)" value={flaky} onChange={setFlaky} />
          <Text>{`Load attempts: ${attempt}`}</Text>
          {source === 'mock' ? <Text style={styles.badge}>Offline mock</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable style={styles.row} onPress={() => open(item.id)} accessibilityRole="button">
          <Text style={styles.name}>{item.title}</Text>
          <Text>{`$${item.price}`}</Text>
        </Pressable>
      )}
      ListFooterComponent={
        <CapturedNote
          lines={[
            'Network requests for the product list',
            'Breadcrumb on pull to refresh',
            'Handled exception when the flaky API fails',
          ]}
        />
      }
    />
  );
}
const styles = StyleSheet.create({
  content: { padding: 16 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: '#ddd',
  },
  name: { flex: 1, marginRight: 8 },
  badge: { alignSelf: 'flex-start', backgroundColor: '#fde68a', paddingHorizontal: 8, borderRadius: 4, marginTop: 4 },
  error: { color: '#b91c1c', marginTop: 4 },
});
