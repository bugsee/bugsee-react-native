import { SpanStatus } from '@bugsee/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Button, Image, StyleSheet, Text } from 'react-native';
import { findProduct } from '../../demoApi';
import type { Product } from '../../demoApi';
import { addToCart, cart, stepSpan } from '../../shop/flow';
import { CapturedNote } from '../../ui/CapturedNote';
import { Screen } from '../../ui/Screen';

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);
  const [missing, setMissing] = useState(false);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    const s = stepSpan('detail');
    setMissing(false);
    findProduct(String(id))
      .then((p) => {
        setProduct(p);
        setMissing(!p);
        s.finish(p ? SpanStatus.OK : SpanStatus.Error);
      })
      .catch(() => {
        setMissing(true);
        s.finish(SpanStatus.Error);
      });
  }, [id]);

  if (missing) {
    return (
      <Screen title="Product">
        <Text style={styles.title}>Product not found</Text>
        <Button title="Back to products" onPress={() => router.back()} />
      </Screen>
    );
  }

  const add = () => {
    if (product) {
      addToCart(product.price);
      setAdded(cart.items);
    }
  };

  return (
    <Screen title="Product">
      {product?.thumbnail ? <Image source={{ uri: product.thumbnail }} style={styles.image} /> : null}
      <Text style={styles.title}>{product?.title ?? 'Loading...'}</Text>
      {product ? <Text>{`$${product.price}`}</Text> : null}
      {product ? <Text style={styles.desc}>{product.description}</Text> : null}
      <Button title="Add to cart" onPress={add} />
      {added > 0 ? <Text style={styles.desc}>{`In cart: ${added}`}</Text> : null}
      {added > 0 ? <Button title="Checkout" onPress={() => router.push('/shop/checkout')} /> : null}
      <CapturedNote lines={['Attribute cart_items updated on add', 'Image request in the network log']} />
    </Screen>
  );
}
const styles = StyleSheet.create({
  image: { width: '100%', height: 200, marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  desc: { marginVertical: 8 },
});
