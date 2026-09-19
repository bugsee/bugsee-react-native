import { PixelRatio, Platform } from 'react-native';

/**
 * How many target-SDK units there are per React Native point, for this
 * platform.
 *
 * The two SDKs take different units and the iOS header states it: "Coordinates
 * are in points in the screen's coordinate space, origin top-left — the same
 * convention as `+[Bugsee addSecureRectangle:]` (Android uses pixels, matching
 * its own `addSecureRectangle`)."
 *
 * React Native measures in density-independent points, which ARE iOS points
 * and are NOT Android pixels. So iOS is 1:1 and Android scales by the device
 * pixel ratio.
 *
 * Read per call rather than cached: the ratio can change under the app when a
 * display configuration changes, and a stale value redacts the wrong region
 * while continuing to look correct.
 */
export function secureRectangleScale(): number {
  return Platform.OS === 'android' ? PixelRatio.get() : 1;
}
