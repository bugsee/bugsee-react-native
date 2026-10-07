/**
 * @format
 */

import { AppRegistry } from 'react-native';
import Bugsee from '@bugsee/react-native';
import BareApp from './App';
import { name as appName } from './app.json';
// Gitignored, written by scripts/write-credentials.mjs and the device e2e.
import credentials from './credentials.json';
import scenarioFile from './e2e-scenario.json';
import { createSmokeApp } from './smoke/SmokeApp';

// `"root": "smoke"` in the scenario file (the e2e's E2E_SMOKE_ROOT=1) runs
// the generated apps' root component (smoke/SmokeApp.tsx) instead, so the
// root those apps register is proven here too. Either way the root is
// wrapped: Bugsee.wrap installs the view-tree anchor.
const App = scenarioFile.root === 'smoke' ? createSmokeApp(credentials, scenarioFile) : BareApp;

AppRegistry.registerComponent(appName, () => Bugsee.wrap(App));
