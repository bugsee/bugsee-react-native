import { parseObjcEnums } from '../ios-enums';

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
});
