/**
 * Autolinking for the example-only module (Task 7.6a). Only examples/bare
 * depends on this package, so only that app links it; @bugsee/react-native
 * never names it (scripts/__tests__/example-wiring.test.ts pins both).
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.bugsee.e2enative.BugseeE2EPackage;',
        packageInstance: 'new BugseeE2EPackage()',
      },
      ios: {
        podspecPath: './BugseeE2ENative.podspec',
      },
    },
  },
};
