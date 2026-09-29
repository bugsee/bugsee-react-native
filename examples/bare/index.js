/**
 * @format
 */

import { AppRegistry } from 'react-native';
import Bugsee from '@bugsee/react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => Bugsee.wrap(App));
