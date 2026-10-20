import Bugsee from '@bugsee/react-native';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import { leaveShop, SHOP_NETWORK_FILTER, startCheckoutFlow } from '../../src/shop/flow';

function ReportButton({ screen }: { screen: string }) {
  return (
    <Pressable onPress={() => Bugsee.showReportDialog(`Problem on ${screen}`)} accessibilityRole="button">
      <Text>Report a problem</Text>
    </Pressable>
  );
}

const screenOptions = (title: string, name: string) => ({
  title,
  headerRight: () => <ReportButton screen={name} />,
});

export default function ShopLayout() {
  useEffect(() => {
    Bugsee.setNetworkFilter(SHOP_NETWORK_FILTER);
    startCheckoutFlow();
    return () => {
      Bugsee.setNetworkFilter(null);
      leaveShop();
    };
  }, []);
  return (
    <Stack>
      <Stack.Screen name="sign-in" options={screenOptions('Sign in', 'sign-in')} />
      <Stack.Screen name="products" options={screenOptions('Products', 'products')} />
      <Stack.Screen name="product/[id]" options={screenOptions('Product', 'product')} />
      <Stack.Screen name="checkout" options={screenOptions('Checkout', 'checkout')} />
    </Stack>
  );
}
