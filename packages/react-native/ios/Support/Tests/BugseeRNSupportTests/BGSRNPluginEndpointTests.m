@import XCTest;

@import BugseeRNSupport;

@interface BGSRNPluginEndpointTests : XCTestCase
@end

@implementation BGSRNPluginEndpointTests

static NSString *const kDead = @"https://127.0.0.1:9/v2";

- (void)testTheInfoPlistKeyIsThePlugins {
  XCTAssertEqualObjects(BGSRNPluginEndpointInfoKey, @"BugseeReactNativeEndpoint");
}

- (void)testAddsTheConfiguredEndpointWhenJsGaveNone {
  NSDictionary *options = @{@"com.bugsee.option.config.duration" : @5};
  NSDictionary *result = BGSRNOptionsWithPluginEndpoint(options, [NSString stringWithFormat:@" %@\n", kDead]);
  XCTAssertEqualObjects(result, (@{@"com.bugsee.option.config.duration" : @5, @"endpoint" : kDead}));
  XCTAssertEqual(options.count, 1u);
  XCTAssertEqualObjects(BGSRNOptionsWithPluginEndpoint(nil, kDead), @{@"endpoint" : kDead});
}

- (void)testKeepsAnEndpointJsPassed {
  NSDictionary *options = @{@"endpoint" : @"https://js.example.com/v2"};
  XCTAssertEqual(BGSRNOptionsWithPluginEndpoint(options, kDead), options);
}

- (void)testChangesNothingWithoutAConfiguredString {
  NSDictionary *options = @{@"k" : @YES};
  XCTAssertEqual(BGSRNOptionsWithPluginEndpoint(options, nil), options);
  XCTAssertEqual(BGSRNOptionsWithPluginEndpoint(options, @""), options);
  XCTAssertEqual(BGSRNOptionsWithPluginEndpoint(options, @" \t\n"), options);
  XCTAssertEqual(BGSRNOptionsWithPluginEndpoint(options, @9), options);
  XCTAssertEqualObjects(BGSRNOptionsWithPluginEndpoint(nil, nil), @{});
}

@end
