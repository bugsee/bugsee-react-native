import { parseObjcEnums, readObjcEnum } from '../ios-enums';

describe('parseObjcEnums', () => {
  it('reads the trailing-typedef form the SDK uses', () => {
    expect(parseObjcEnums(`
typedef enum : NSUInteger {
    /** Low severity (lowest available) */
    BugseeSeverityLow = 1,
    BugseeSeverityMedium = 2,
    BugseeSeverityBlocker = 5
} BugseeSeverityLevel;
`)).toEqual({
      BugseeSeverityLevel: { BugseeSeverityLow: 1, BugseeSeverityMedium: 2, BugseeSeverityBlocker: 5 },
    });
  });

  it('reads the NS_ENUM form', () => {
    expect(parseObjcEnums(`
typedef NS_ENUM(NSInteger, BGSIssueType) {
    BGSIssueTypeBug = 0,
    BGSIssueTypeCrash,
    BGSIssueTypeError,
};
`)).toEqual({ BGSIssueType: { BGSIssueTypeBug: 0, BGSIssueTypeCrash: 1, BGSIssueTypeError: 2 } });
  });

  // The trap that makes this worth parsing rather than grepping: a member with
  // no `= n` takes the previous value plus one. Reading only the explicit ones
  // would silently skip members, and skipping a member is how an enum ends up
  // looking like it agrees when it does not.
  it('continues an implicit sequence from the last explicit value', () => {
    expect(parseObjcEnums(`
typedef NS_ENUM(NSInteger, E) {
    EA = 10,
    EB,
    EC,
    ED = 20,
    EE,
};
`).E).toEqual({ EA: 10, EB: 11, EC: 12, ED: 20, EE: 21 });
  });

  it('reads members that carry NS_SWIFT_NAME', () => {
    expect(parseObjcEnums(`
typedef NS_ENUM(NSUInteger, BugseeCrashHandlerType) {
    BugseeCrashHandlerTypeBSD NS_SWIFT_NAME(bsd) = 1,
    BugseeCrashHandlerTypeMach NS_SWIFT_NAME(mach) = 2,
    BugseeCrashHandlerTypeMachAndBSD NS_SWIFT_NAME(machAndBSD) = 3
};
`)).toEqual({
      BugseeCrashHandlerType: {
        BugseeCrashHandlerTypeBSD: 1,
        BugseeCrashHandlerTypeMach: 2,
        BugseeCrashHandlerTypeMachAndBSD: 3,
      },
    });
  });

  it('ignores comments, including ones naming other enums', () => {
    expect(parseObjcEnums(`
// typedef NS_ENUM(NSInteger, NotReal) { NotRealA = 99 };
/** See BugseeSeverityLevel for the real one. */
typedef NS_ENUM(NSInteger, E) { EA = 1 };
`)).toEqual({ E: { EA: 1 } });
  });

  it('finds several enums in one header', () => {
    const parsed = parseObjcEnums(`
typedef NS_ENUM(NSInteger, A) { AA = 1 };
typedef enum : NSUInteger { BB = 2 } B;
`);
    expect(Object.keys(parsed).sort()).toEqual(['A', 'B']);
  });

  it('returns nothing for a header with no enums', () => {
    expect(parseObjcEnums('@interface Foo : NSObject\n@end')).toEqual({});
  });

  it('reads a Swift name that has its own parentheses', () => {
    expect(parseObjcEnums(`
typedef NS_ENUM(NSInteger, E) { EA NS_SWIFT_NAME(a(b:)) = 4 };
`).E).toEqual({ EA: 4 });
  });

  it('reports the entries it could not read instead of dropping them silently', () => {
    const skipped: Record<string, string[]> = {};
    const parsed = parseObjcEnums(`
typedef NS_ENUM(NSInteger, E) {
    EA = 1,
    EB API_AVAILABLE(ios(13.0)) = 2,
    EAll = (EA | EB),
};
typedef NS_ENUM(NSInteger, F) { FA = 1 };
`, skipped);
    expect(parsed.E).toEqual({ EA: 1 });
    expect(skipped).toEqual({ E: ['EB API_AVAILABLE(ios(13.0)) = 2', 'EAll = (EA | EB)'] });
  });
});

describe('readObjcEnum', () => {
  it('returns an enum read whole', () => {
    expect(readObjcEnum('typedef NS_ENUM(NSInteger, E) { EA = 1, EB };', 'E')).toEqual({ EA: 1, EB: 2 });
  });

  it('throws when the enum is missing', () => {
    expect(() => readObjcEnum('typedef NS_ENUM(NSInteger, E) { EA = 1 };', 'F')).toThrow('F not found');
  });

  it('throws when a member could not be read', () => {
    expect(() => readObjcEnum('typedef NS_ENUM(NSInteger, E) { EA = 1, EAll = (EA | 2) };', 'E'))
      .toThrow('could not read "EAll = (EA | 2)"');
  });

  it('throws when the enum has no members', () => {
    expect(() => readObjcEnum('typedef NS_ENUM(NSInteger, E) { };', 'E')).toThrow('no members');
  });
});
