import type { ExpoConfig } from 'expo/config';
import { readBugseeConfigFile, resolveBugseeConfig } from './config/bugseeConfig.ts';

const { pluginProps, extra } = resolveBugseeConfig({ file: readBugseeConfigFile(__dirname), env: process.env });

const config: ExpoConfig = {
  name: 'Bugsee Playground',
  slug: 'bugsee-playground',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'bugsee-playground',
  ios: { bundleIdentifier: 'com.bugsee.playground', supportsTablet: false },
  android: { package: 'com.bugsee.playground' },
  plugins: [
    'expo-router',
    ['expo-camera', { cameraPermission: 'The camera scans the QR code of your Bugsee app token.', recordAudioAndroid: false }],
    ['@bugsee/react-native', pluginProps],
  ],
  extra,
};
export default config;
