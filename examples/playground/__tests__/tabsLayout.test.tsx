import Ionicons from '@expo/vector-icons/Ionicons';
import { TABS } from '../app/(tabs)/_layout';

describe('tab bar icons', () => {
  it('gives every tab an icon that exists in the Ionicons font', () => {
    expect(TABS.length).toBe(7);
    for (const [, , icon] of TABS) expect(Ionicons.glyphMap).toHaveProperty(icon);
  });
});
