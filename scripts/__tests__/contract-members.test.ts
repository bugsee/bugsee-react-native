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

  it('returns names sorted, not in declaration order', () => {
    expect(parseJavaMembers(`
public interface R {
    void zebra();
    void alpha();
}
`)).toEqual(['alpha', 'zebra']);
  });

  // A bare regex could mistake a control-flow or expression keyword for a
  // method name when it sits directly before "(" with something type-like
  // in front of it. NOT_A_METHOD exists to filter exactly that out.
  it('excludes control-flow and expression keywords that a bare regex could mistake for a method name', () => {
    expect(parseJavaMembers(`
public interface R {
    Type if(a);
    Type for(a);
    Type while(a);
    Type switch(a);
    Type catch(a);
    Type return(a);
    Type new(a);
    void real();
}
`)).toEqual(['real']);
  });

  // A block comment sitting inline, between a type and a name, must be
  // stripped entirely -- leaving any placeholder text behind (rather than
  // an empty string) would corrupt the type/name split and hide the member.
  it('strips an inline block comment cleanly enough that the member after it is still found', () => {
    expect(parseJavaMembers(`
public interface R {
    String /* inline doc, with spaces */ getFoo();
}
`)).toEqual(['getFoo']);
  });

  // A method is only recognised at the true start of its line: a second
  // statement crammed onto the same line as a field is not read as a member.
  it('does not find a member that is not the first token on its line', () => {
    expect(parseJavaMembers(`
public interface R {
    int x; void hidden();
    void real();
}
`)).toEqual(['real']);
  });

  it('reads a member with no leading indentation', () => {
    expect(parseJavaMembers('interface R {\nvoid real();\n}')).toEqual(['real']);
  });

  // A multi-line annotation call (its closing paren on a later line) must be
  // stripped as a whole so its own text never gets read as a member.
  it('strips a multi-line annotation before a member', () => {
    expect(parseJavaMembers(`
public interface R {
    @Deprecated(
        since = "1.0"
    )
    void real();
}
`)).toEqual(['real']);
  });

  // A tab is whitespace, same as a run of spaces, between a modifier and the
  // type that follows it.
  it('accepts a tab between a modifier and the type that follows it', () => {
    expect(parseJavaMembers('interface R {\n    public\tString getId();\n}'))
      .toEqual(['getId']);
  });

  // Two tabs between the type and the name are still just whitespace, not
  // one required tab and one stray character.
  it('accepts more than one tab between the type and the name', () => {
    expect(parseJavaMembers('interface R {\n    String\t\tgetId();\n}'))
      .toEqual(['getId']);
  });

  // Whitespace before the opening parenthesis is still part of the
  // declaration, not a break that hides the method.
  it('accepts whitespace between the name and the opening parenthesis', () => {
    expect(parseJavaMembers('interface R {\n    void getFoo ();\n}'))
      .toEqual(['getFoo']);
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
      .toThrow(
        'protocol Missing not found. A missing protocol must fail here rather ' +
          'than compare as an empty one, which reads as a total gap.',
      );
  });

  it('returns names sorted, not in declaration order', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
- (void)zebra;
- (void)alpha;
@end
`, 'P')).toEqual(['alpha', 'zebra']);
  });

  // A method selector is only recognised at the true start of its line.
  it('does not find a method that is not the first token on its line', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
NSInteger x = -1; - (void)hidden;
- (void)real;
@end
`, 'P')).toEqual(['real']);
  });

  it('accepts a method with no space before the opening parenthesis', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
-(void)compact;
@end
`, 'P')).toEqual(['compact']);
  });

  // A property with no attribute list at all is still a property: the
  // parenthesised attribute list is optional, not required.
  it('reads a property with no attribute list', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
@property NSString *plainName;
@end
`, 'P')).toEqual(['plainName']);
  });

  it('accepts whitespace before the semicolon that ends a property', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
@property(nonatomic) NSString *name ;
@end
`, 'P')).toEqual(['name']);
  });

  it('does not find a property that is not the first token on its line', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
NSInteger x = 1; @property(nonatomic) NSString *hidden;
@property(nonatomic) NSString *real;
@end
`, 'P')).toEqual(['real']);
  });

  it('accepts a property whose type follows its attribute list with no space', () => {
    expect(parseObjcMembers(`
@protocol P <NSObject>
@property(nonatomic)NSString *tight;
@end
`, 'P')).toEqual(['tight']);
  });
});
