import { parseJavaMembers, parseObjcMembers } from '../contract-members';

describe('parseJavaMembers', () => {
  it('reads method names from an interface, ignoring comments and annotations', () => {
    expect(parseJavaMembers(`
public interface Report {
    /** The id. */
    @NonNull
    String getId();

    void setSummary(@Nullable final String summary);

    // void notAMember();
}
`)).toEqual(['getId', 'setSummary']);
  });

  it('includes default methods, which are members a wrapper may override', () => {
    expect(parseJavaMembers(`
public interface W {
    default int[] getSecureRectangles(final int display) {
        return new int[] { 1, 0 };
    }
    String getWrapperType();
}
`).sort()).toEqual(['getSecureRectangles', 'getWrapperType']);
  });

  /** Overloads are one capability, not several. */
  it('reports an overloaded name once', () => {
    expect(parseJavaMembers(`
public interface R {
    void setScreenshot(final int displayId, final Bitmap b);
    void setScreenshot(final Bitmap b);
}
`)).toEqual(['setScreenshot']);
  });

  it('ignores constants and nested types', () => {
    expect(parseJavaMembers(`
public interface R {
    String PREFIX = "com.bugsee.";
    enum Kind { A, B }
    void real();
}
`)).toEqual(['real']);
  });
});

describe('parseObjcMembers', () => {
  it('reads properties and the first selector segment of methods', () => {
    expect(parseObjcMembers(`
@protocol BGSReportContract <NSObject>
@property(nonatomic, copy, readonly) NSString *reportId;
- (void)addLabel:(NSString *)label;
- (nullable id)attributeForName:(NSString *)name;
@end
`, 'BGSReportContract').sort()).toEqual(['addLabel', 'attributeForName', 'reportId']);
  });

  it('reads only the named protocol, not its neighbours', () => {
    expect(parseObjcMembers(`
@protocol Other <NSObject>
- (void)shouldNotAppear;
@end
@protocol Wanted <NSObject>
- (void)wanted;
@end
`, 'Wanted')).toEqual(['wanted']);
  });

  it('ignores comments, including a commented-out member', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
/// - (void)documented;
// - (void)commentedOut;
- (void)real;
@end
`, 'P')).toEqual(['real']);
  });

  it('keeps optional members, which are still contract surface', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
- (void)required;
@optional
- (void)maybe;
@end
`, 'P').sort()).toEqual(['maybe', 'required']);
  });

  it('returns nothing when the protocol is absent, rather than pretending it is empty', () => {
    expect(() => parseObjcMembers('@protocol A <NSObject>\n@end', 'Missing'))
      .toThrow(/Missing/);
  });
});
