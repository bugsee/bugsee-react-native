import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { mask, scanJava, scanObjC, scanPackages, scanTs, scannerFor, walk } from '../raw-messages';

/**
 * One fixture per shape: every leak shape the three reviews probed (flagged)
 * and every audited safe form (allowed). The real trees are scanned by
 * raw-messages-tree.test.ts.
 */

const rulesOf = (violations: Array<{ rule: string }>): string[] => violations.map((v) => v.rule);

/** The rule labels, so each fixture states exactly which rules it trips. */
const J = {
  caught: (types: string, name: string): string =>
    `caught ${types} \`${name}\` used other than by its class name or an audited helper`,
  declared: (type: string, name: string): string =>
    `${type} \`${name}\` used other than by its class name or an audited helper`,
  construct: 'an exception message built from something other than literals, identifiers and sizes',
  rejectArg: 'a reject argument other than a literal, an identifier or a fixed failure message',
  rejectShape: 'reject(Throwable), or a reject carrying more than a code and a message',
  log3: 'Log call with a bare Throwable last argument (prints its message and stack)',
  printStackTrace: 'printStackTrace()',
  stackTraceString: 'Log.getStackTraceString(...)',
  wtf: 'Log.wtf(...)',
};

const O = {
  localizedDescription: 'localizedDescription read outside BGSRNErrorMessage',
  userInfo: 'userInfo read outside BGSRNErrorMessage',
  reason: 'NSException reason read',
  failureReason: 'localizedFailureReason read',
  recoverySuggestion: 'localizedRecoverySuggestion read',
  debugDescription: 'debugDescription read',
  description: 'description read',
  callStack: 'exception call stack read',
  what: 'std::exception::what() read',
  caught: (name: string): string =>
    `caught NSException \`${name}\` used other than by its class/name or BGSRNRejectException`,
  cpp: (name: string): string => `caught C++ exception \`${name}\` used other than by typeid()`,
  formatted: (name: string): string => `NSError/NSException \`${name}\` formatted into a log, format or reject call`,
  thirdArgument: "reject's third argument is not nil (RN serialises the NSError's userInfo into JS)",
  rejectArg: 'a reject argument other than a literal, an identifier or an audited message',
  opaqueUserInfo: 'an NSError built with a userInfo the scanner cannot see (nil or a dictionary literal only)',
  errorDescription: 'an NSError description that is not a string literal or a named constant',
  identifier: 'a BGSRNErrorIdentifierKey entry that is not the identifier `key`',
};

const T = {
  sink: 'an error or console message built from something other than literals, identifiers and type names',
};

describe('mask', () => {
  it('blanks comments, keeping length and line breaks', () => {
    expect(mask('a // x(\nb /* y\n( */ c', 'java')).toBe('a      \nb     \n     c');
    expect(mask('x // tail', 'java')).toBe('x        ');
    expect(mask('x /* open', 'java')).toBe('x        ');
  });

  it('blanks string and char literal contents, keeping the quotes', () => {
    expect(mask('f("a(b", \'(\')', 'java')).toBe('f("   ", \' \')');
    expect(mask('f("a\\"(")', 'java')).toBe('f("    ")');
    expect(mask('@"s(" x', 'objc')).toBe('@"  " x');
  });

  it('ends an unterminated literal at the line break or the end', () => {
    expect(mask('"ab\nc"d"', 'java')).toBe('"  \nc" "');
    expect(mask('x = "ab', 'java')).toBe('x = "  ');
    expect(mask('"', 'java')).toBe('"');
  });

  it('keeps a template interpolation as code and blanks the text', () => {
    expect(mask('`a(${x}b`', 'ts')).toBe('`  ${x} `');
    expect(mask('`${ {a: "("}.a }`', 'ts')).toBe('`${ {a: " "}.a }`');
    expect(mask('`${`in${y}`}z`', 'ts')).toBe('`${`  ${y}`} `');
    expect(mask('`\\`(`', 'ts')).toBe('`   `');
    expect(mask('`${x', 'ts')).toBe('`${x');
    expect(mask('`open', 'ts')).toBe('`    ');
  });

  it.each(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';'])(
    'reads a / after %p as a regex literal',
    (preceder) => {
      expect(mask(`x${preceder} /'(/g`, 'ts')).toBe(`x${preceder} /  /g`);
    },
  );

  it('reads a / at the start of a file as a regex literal', () => {
    expect(mask("/'/.test(x)", 'ts')).toBe('/ /.test(x)');
  });

  it('reads a / after an operand as division', () => {
    expect(mask('x = a / "(" / b', 'ts')).toBe('x = a / " " / b');
  });

  it('keeps a / inside a regex character class and after an escape', () => {
    expect(mask("x = /[/']/; y = '('", 'ts')).toBe("x = /    /; y = ' '");
    expect(mask("x = /\\/'/; y", 'ts')).toBe('x = /   /; y');
    expect(mask("x = /a'\ny", 'ts')).toBe('x = /  \ny');
  });

  it('has no regex literals outside TypeScript', () => {
    expect(mask("x = /'/ + 1", 'java')).toBe("x = /'     ");
    expect(mask('x = `a`', 'java')).toBe('x = `a`');
  });
});

function javaCatch(body: string, type = 'RuntimeException', name = 'e'): string {
  return `try {\n  doSomething();\n} catch (final ${type} ${name}) {\n  ${body}\n}\n`;
}

describe('scanJava', () => {
  const flagged = (label: string, source: string, rules: string[], path = 'Fixture.java'): void => {
    it(`flags: ${label}`, () => {
      expect(rulesOf(scanJava(path, source))).toEqual(rules);
    });
  };
  const allowed = (label: string, source: string, path = 'Fixture.java'): void => {
    it(`allows: ${label}`, () => {
      expect(scanJava(path, source)).toEqual([]);
    });
  };

  flagged('promise.reject(e)', javaCatch('promise.reject(e);'), [J.caught('RuntimeException', 'e'), J.rejectArg, J.rejectShape]);
  flagged('a multi-line promise.reject(e)', javaCatch('promise.reject(\n  e\n);'), [J.caught('RuntimeException', 'e'), J.rejectArg, J.rejectShape]);
  flagged('a Throwable t logged by Log.w', javaCatch('Log.w(TAG, "x", t);', 'Throwable', 't'), [J.caught('Throwable', 't'), J.log3]);
  flagged('a lambda Log.w(TAG, message, error)', 'D d = (message, error) -> Log.w(TAG, message, error);', [J.log3]);
  flagged('"x " + e', javaCatch('Log.w(TAG, "x " + e);'), [J.caught('RuntimeException', 'e')]);
  flagged('"" + e', javaCatch('String s = "" + e;'), [J.caught('RuntimeException', 'e')]);
  flagged('String.valueOf(e)', javaCatch('Log.w(TAG, String.valueOf(e));'), [J.caught('RuntimeException', 'e')]);
  flagged('promise.reject("C", e)', javaCatch('promise.reject("C", e);'), [J.caught('RuntimeException', 'e'), J.rejectArg]);
  flagged('promise.reject("C", "m", e)', javaCatch('promise.reject("C", "m", e);'), [J.caught('RuntimeException', 'e'), J.rejectArg, J.rejectShape]);
  flagged('Log.wtf', 'Log.wtf(TAG, "x");', [J.wtf]);
  flagged('printStackTrace', 'error.printStackTrace();', [J.printStackTrace]);
  flagged('Log.getStackTraceString', 'Log.w(TAG, Log.getStackTraceString(error));', [J.stackTraceString]);
  flagged('a multi-catch', javaCatch('Log.w(TAG, "x " + e);', 'IOException | RuntimeException'), [J.caught('IOException|RuntimeException', 'e')]);
  flagged('a multi-catch that mixes a safe type with a raw one', javaCatch(
    'promise.reject("C", e.getMessage());', 'BridgeJson.BadJson | RuntimeException'), [J.caught('BadJson|RuntimeException', 'e'), J.rejectArg]);
  flagged('e.getCause()', javaCatch('Log.w(TAG, "x" + e.getCause());'), [J.caught('RuntimeException', 'e')]);
  flagged('a message pulled into a local', javaCatch('final String m = e.getMessage(); Log.w(TAG, m);'), [J.caught('RuntimeException', 'e')]);
  flagged('an unbalanced ( inside a literal', javaCatch('Log.w(TAG, "unbalanced ( paren", e);'), [J.caught('RuntimeException', 'e'), J.log3]);
  flagged('e.getMessage()', javaCatch('promise.reject("C", e.getMessage());'), [J.caught('RuntimeException', 'e'), J.rejectArg]);
  flagged('e.toString()', javaCatch('promise.reject("C", e.toString());'), [J.caught('RuntimeException', 'e'), J.rejectArg]);
  flagged('a BadJson catch using anything but getMessage', javaCatch('Log.w(TAG, "x" + e.getCause());', 'BadJson'), [J.caught('BadJson', 'e')]);
  flagged('a Throwable parameter used in a method body', 'void f(final Throwable t) {\n  Log.w(TAG, "x " + t);\n}', [J.declared('Throwable', 't')]);
  flagged('a parameter after a throws clause', 'void f(Exception t) throws Oops {\n  Log.w(TAG, "x " + t);\n}', [J.declared('Exception', 't')]);
  flagged('a local exception', 'void f() {\n  RuntimeException boom = make();\n  Log.w(TAG, "" + boom);\n}', [J.declared('RuntimeException', 'boom')]);
  flagged('a BadArgument built from a value', 'throw new BadArgument("got " + value);', [J.construct]);
  flagged('a qualified BadArgument built from a value', 'throw new ReportOps.BadArgument("got " + value);', [J.construct]);
  flagged('a BadJson built from a variable', 'throw new BadJson(text);', [J.construct]);
  flagged('a BadArgument with another object\'s getMessage()', javaCatch(
    'throw new BadArgument("x" + crumb.getMessage());', 'BadJson'), [J.construct]);
  flagged('a safe catch\'s getMessage() used after its catch', `${javaCatch('', 'BadJson')}throw new BadArgument("x" + e.getMessage());`, [J.construct]);
  flagged('a reject message built from a value', 'promise.reject("C", "got " + value);', [J.rejectArg]);
  flagged('a reject with one non-literal argument', 'promise.reject(message);', [J.rejectArg, J.rejectShape]);
  flagged('a failureMessage built from a call', 'promise.reject(C, ReportOps.failureMessage(e.getMessage()));', [J.rejectArg]);
  flagged('the audited helper\'s body, in another file', 'static String malformedJsonMessage(final JSONException e, final int n) {\n  return String.valueOf(e.getMessage());\n}', [J.declared('JSONException', 'e')], 'Other.java');

  allowed('e.getClass().getName()', javaCatch('Log.e(TAG, "x: " + e.getClass().getName());'));
  allowed('e.getClass().getSimpleName()', javaCatch('Log.e(TAG, "x: " + e.getClass().getSimpleName());'));
  allowed('e?.getClass()', javaCatch('Log.e(TAG, "x: " + e?.getClass().getName());'));
  allowed('rejectReportFailure(promise, op, e)', javaCatch('rejectReportFailure(promise, "reportRead", e);'));
  allowed('rejectAttributeFailure(promise, op, e)', javaCatch('rejectAttributeFailure(promise, "getAttribute", e);'));
  allowed('diagnostics.report(message, e)', javaCatch('diagnostics.report("the filter threw", e);'));
  allowed('Bugsee.logException(t, options)', 'void log(final Throwable t) {\n  Bugsee.logException(t, options);\n}');
  allowed('Bugsee.logUnhandledException(t, options)', 'void log(final Throwable t) {\n  Bugsee.logUnhandledException(t, options);\n}');
  allowed('a BadArgument forwarding its own message', javaCatch(
    'promise.reject(E_REPORT_BAD_ARGUMENT, e.getMessage());', 'ReportOps.BadArgument'));
  allowed('a BadJson message folded into a BadArgument', javaCatch(
    'throw new BadArgument("patch is not a JSON object: " + e.getMessage());', 'BridgeJson.BadJson'));
  allowed('a JSONException handed to malformedJsonMessage', javaCatch(
    'throw new BadJson(malformedJsonMessage(e, json.length()));', 'JSONException'));
  allowed('a BadArgument naming a key', 'throw new BadArgument("attribute \\"" + key + "\\" must be a string");');
  allowed('a BadArgument naming entry.getKey()', 'throw new BadArgument("attribute \\"" + entry.getKey() + "\\"");');
  allowed('a BadArgument with constants and numbers', 'throw new BadArgument("at most " + MAX_LENGTH + " of " + 3);');
  allowed('a reject naming the attribute', 'promise.reject(E_ATTRIBUTE_REJECTED, "attribute \\"" + name + "\\" was not kept");');
  allowed('a reject with a fixed failure message', 'promise.reject(E_ATTRIBUTE_REJECTED, AttributeBridge.failureMessage(operation));');
  allowed('a reject with a cast null code', 'promise.reject((String) null, ReportOps.failureMessage(operation));');
  allowed('a reject with an explicit null throwable', 'promise.reject("E_X", "m", null);');
  allowed('a reject with one literal', 'promise.reject("E_X");');
  allowed('a two-argument Log call', 'Log.d(TAG, "op ok");');
  allowed('Log.e itself when the variable is named e', javaCatch('Log.e(TAG, "op failed: " + e.getClass().getName());'));
  allowed('an abstract parameter, whose name is reused elsewhere', 'interface D { void report(String m, Throwable error); }\nvoid g() { Log.w(TAG, "x" + error); }');
  allowed('the audited helper\'s body in BridgeJson.java', 'static String malformedJsonMessage(final JSONException e, final int n) {\n  return String.valueOf(e.getMessage());\n}', 'BridgeJson.java');

  // Spacing and nesting the canonical formatting never uses, so a rule that
  // only matches tidy code would miss them.
  flagged('a catch with no spaces', 'try { a(); } catch(RuntimeException e){ Log.w(TAG, "" + e); }', [J.caught('RuntimeException', 'e')]);
  flagged('a catch spread out', 'try { a(); } catch  (  final   IOException  |  RuntimeException   boom  )   {\n  use(boom);\n}', [J.caught('IOException|RuntimeException', 'boom')]);
  flagged('a Throwable parameter after an annotated one', 'void f(@Named(value = "x") String a, Throwable  t) {\n  Log.w(TAG, "" + t);\n}', [J.declared('Throwable', 't')]);
  flagged('a local exception after a sibling block', 'void f() {\n  if (x) { a(); }\n  IllegalStateException boom = m();\n  Log.w(TAG, "" + boom);\n}', [J.declared('IllegalStateException', 'boom')]);
  flagged('a qualified local exception', 'void f() {\n  java.io.IOException io = m();\n  Log.w(TAG, "" + io);\n}', [J.declared('IOException', 'io')]);
  flagged('a local AssertionError', 'void f() {\n  AssertionError oops = m();\n  Log.w(TAG, "" + oops);\n}', [J.declared('AssertionError', 'oops')]);
  flagged('a Throwable parameter in a method after a catch', `${javaCatch('Log.e(TAG, "x");')}void f(Throwable t) {\n  Log.w(TAG, "" + t);\n}`, [J.declared('Throwable', 't')]);
  flagged('spaced calls', 'x.printStackTrace  ();\nLog.getStackTraceString  (x);\nLog.wtf  (TAG, "m");\nLog.w  (TAG, "m", t);\npromise.reject  (t);\nthrow new   BadJson  (text);', [J.construct, J.rejectArg, J.rejectShape, J.log3, J.printStackTrace, J.stackTraceString, J.wtf]);
  flagged('a class name that goes on to be transformed', javaCatch('promise.reject("C", boom.getClass().getName().concat(msg));', 'RuntimeException', 'boom'), [J.rejectArg]);
  flagged('a failureMessage built from a value', 'promise.reject(C, failureMessage(op) + value);', [J.rejectArg]);
  flagged('a literal followed by more', 'promise.reject("C", "m".concat(value));', [J.rejectArg]);
  flagged('a number followed by more', 'throw new BadArgument(3 + value.length());', [J.construct]);
  flagged('a malformedJsonMessage that is only a prefix', 'throw new BadJson(malformedJsonMessage(e, n) + text);', [J.construct]);
  flagged('a getMessage that is only a prefix', javaCatch('throw new BadArgument(e.getMessage().trim());', 'BadJson'), [J.construct]);
  // Review M2 (J24) and M1 (J25).
  flagged('a failureMessage for something other than the operation', 'promise.reject("E", ReportOps.failureMessage(summary));', [J.rejectArg]);
  flagged('any exception built from a value', 'throw new IllegalArgumentException("color component out of range: " + value);', [J.construct]);
  flagged('a qualified exception built from a value', 'throw new java.lang.IllegalStateException(value);\nthrow new org.json.JSONException("bad " + text);', [J.construct, J.construct]);
  allowed('a failureMessage for a literal operation', 'promise.reject(C, ReportOps.failureMessage("reportRead"));');
  allowed('an exception built from literals and a size', 'throw new IllegalArgumentException("need 4 coordinates each, got " + coordinates.length);\nthrow new JSONException("data key is not a string");');
  allowed('the JS exception report itself', 'sdk.logException(new ReactNativeWebException(payloadJson), opts);');
  allowed('an allowed argument after a nested call', javaCatch('rejectReportFailure(promise, names.of(op), e);'));
  allowed('a parenthesised message', 'throw new BadArgument(("attribute " + key) + " must be a string");');
  allowed('a class name of a long-named exception', javaCatch('promise.reject("C", boom.getClass().getName() + boom?.getClass().getSimpleName());', 'RuntimeException', 'boom'));
  allowed('a decimal number', 'throw new BadArgument("at most " + 2.5 + " units");');
  allowed('a getMessage of a long-named safe exception', javaCatch('throw new BadArgument("bad: " + bad.getMessage());', 'BadJson', 'bad'));
  allowed('the audited helper with its full argument list', javaCatch('throw new BadJson(malformedJsonMessage(e, json.length()));', 'JSONException'));
  allowed('a reject through a long-named failure message', 'promise.reject(C, ReportOps.failureMessage(operation));\npromise.reject(C, failureMessage(operation));');

  it('names the caught type and variable, the line, and the raw source', () => {
    const [violation] = scanJava('A.java', javaCatch('Log.w(TAG, "s3cret " + e);', 'IllegalStateException', 'boom'));
    expect(violation).toBeUndefined();
    const [first] = scanJava('A.java', javaCatch('Log.w(TAG, "s3cret " + boom);', 'IllegalStateException', 'boom'));
    expect(first).toEqual({
      file: 'A.java',
      line: 4,
      rule: 'caught IllegalStateException `boom` used other than by its class name or an audited helper',
      snippet: 'Log.w(TAG, "s3cret " + boom);',
    });
  });

  it('labels each rule', () => {
    expect(rulesOf(scanJava('A.java', 'void f(final Throwable t) {\n  Log.w(TAG, "" + t);\n}'))).toEqual([
      'Throwable `t` used other than by its class name or an audited helper',
    ]);
    expect(rulesOf(scanJava('A.java', 'throw new BadArgument("got " + value);'))).toEqual([
      'an exception message built from something other than literals, identifiers and sizes',
    ]);
    expect(rulesOf(scanJava('A.java', 'promise.reject(message);'))).toEqual([
      'a reject argument other than a literal, an identifier or a fixed failure message',
      'reject(Throwable), or a reject carrying more than a code and a message',
    ]);
    expect(rulesOf(scanJava('A.java', 'Log.w(TAG, "m", error);'))).toEqual([
      'Log call with a bare Throwable last argument (prints its message and stack)',
    ]);
    expect(rulesOf(scanJava('A.java', 'x.printStackTrace(); Log.getStackTraceString(x); Log.wtf(TAG, "m");'))).toEqual([
      'printStackTrace()',
      'Log.getStackTraceString(...)',
      'Log.wtf(...)',
    ]);
    expect(scanJava('A.java', 'promise.reject("C", "m", e);')[1]).toMatchObject({
      rule: 'reject(Throwable), or a reject carrying more than a code and a message',
      snippet: '.reject("C", "m", e)',
      line: 1,
    });
  });
});

function objcCatch(body: string, name = 'exception'): string {
  return `@try {\n  doSomething();\n} @catch (NSException *${name}) {\n  ${body}\n}\n`;
}

const cppCatch = (body: string): string => `try {\n  doSomething();\n} catch (const std::exception &e) {\n  ${body}\n}\n`;

describe('scanObjC', () => {
  const flagged = (label: string, source: string, rules: string[], path = 'Fixture.m'): void => {
    it(`flags: ${label}`, () => {
      expect(rulesOf(scanObjC(path, source))).toEqual(rules);
    });
  };
  const allowed = (label: string, source: string, path = 'Fixture.m'): void => {
    it(`allows: ${label}`, () => {
      expect(scanObjC(path, source)).toEqual([]);
    });
  };

  flagged('exception.reason', objcCatch('reject(nil, exception.reason ?: exception.name, nil);'), [O.reason, O.caught('exception'), O.formatted('exception'), O.rejectArg]);
  flagged('[exception reason]', 'NSString *r = [exception reason];', [O.reason]);
  flagged('an exception formatted into NSLog', objcCatch('NSLog(@"threw: %@", exception);'), [O.caught('exception'), O.formatted('exception')]);
  flagged('[exception description]', objcCatch('NSLog(@"%@", [exception description]);'), [O.description, O.caught('exception'), O.formatted('exception')]);
  flagged('exception.description', 'NSString *d = exception.description;', [O.description]);
  flagged('a caught variable named e', objcCatch('NSLog(@"%@", e);', 'e'), [O.caught('e'), O.formatted('e')]);
  flagged('a caught variable named err', objcCatch('NSString *s = [NSString stringWithFormat:@"%@", err];', 'err'), [O.caught('err'), O.formatted('err')]);
  flagged('debugDescription', 'NSString *d = x.debugDescription;', [O.debugDescription]);
  flagged('localizedFailureReason', 'NSString *d = error.localizedFailureReason;', [O.failureReason]);
  flagged('localizedRecoverySuggestion', 'NSString *d = error.localizedRecoverySuggestion;', [O.recoverySuggestion]);
  flagged('callStackSymbols', 'NSArray *s = exception.callStackSymbols;', [O.callStack]);
  flagged('callStackReturnAddresses', 'NSArray *s = [exception callStackReturnAddresses];', [O.callStack]);
  flagged('e.what() in a C++ catch', cppCatch('NSLog(@"%s", e.what());'), [O.what, O.cpp('e')]);
  flagged('a C++ exception passed anywhere', cppCatch('Report(e);'), [O.cpp('e')]);
  flagged('an exception nested in stringWithFormat:', objcCatch('NSLog(@"%@", [NSString stringWithFormat:@"%@", exception]);'), [O.caught('exception'), O.formatted('exception'), O.formatted('exception')]);
  flagged('RCTLogError with the exception', objcCatch('RCTLogError(@"threw: %@", exception);'), [O.caught('exception'), O.formatted('exception')]);
  flagged('os_log_error with the exception', objcCatch('os_log_error(OS_LOG_DEFAULT, "threw: %@", exception);'), [O.caught('exception'), O.formatted('exception')]);
  flagged('a non-nil third reject argument', 'reject(code, @"m", error);', [O.thirdArgument, O.rejectArg]);
  flagged('userInfo, dot syntax', 'NSDictionary *info = error.userInfo;', [O.userInfo]);
  flagged('userInfo, bracket syntax', 'NSDictionary *info = [error userInfo];', [O.userInfo]);
  flagged('localizedDescription, dot syntax', 'NSString *m = error.localizedDescription;', [O.localizedDescription]);
  flagged('localizedDescription, bracket syntax', 'NSString *m = [error localizedDescription];', [O.localizedDescription]);
  flagged(
    'review probe: an unused wire-code call before a raw read',
    'NSError *foo = nil; Parse(&foo); BGSRNReportErrorWireCode(foo); NSLog(@"%@", foo.localizedDescription);', [O.localizedDescription, O.formatted('foo')],
  );
  flagged(
    'review probe: a reused error variable after a bridge-built one',
    'NSError *error = nil;\n[BGSRNReportOps applyPatchJSON:j toReport:r error:&error];\n'
      + 'reject(BGSRNReportErrorWireCode(error), BGSRNErrorMessage(error), nil);\n'
      + 'error = rawError;\nNSLog(@"%@", error.localizedDescription);', [O.localizedDescription, O.formatted('error')],
  );
  flagged('an NSError formatted into NSLog', 'NSError *error = nil;\nNSLog(@"dropped: %@", error);', [O.formatted('error')]);
  flagged('an NSError formatted into stringWithFormat:', 'NSError *_Nullable error = nil;\nNSString *s = [NSString stringWithFormat:@"%@", error];', [O.formatted('error')]);
  flagged('a dereferenced out-parameter formatted into NSLog', '- (BOOL)go:(NSError **)error {\n  NSLog(@"%@", *error);\n}', [O.formatted('error')]);
  flagged('an NSError formatted into appendFormat:', 'NSError *error = nil;\n[s appendFormat:@"%@", error];', [O.formatted('error')]);
  flagged('an NSError formatted into initWithFormat:', 'NSError *error = nil;\n[[NSString alloc] initWithFormat:@"%@", error];', [O.formatted('error')]);
  flagged('a reject message that is a value', 'reject(@"C", value, nil);', [O.rejectArg]);
  flagged('a reject message formatted from a value', 'reject(code, [NSString stringWithFormat:@"got %@", value], nil);', [O.rejectArg]);
  // Review I2: an own-domain error's description is handed on by
  // BGSRNErrorMessage, so every construction is checked, however written.
  flagged('a direct construction with a value in the description', 'if (out) *out = [NSError errorWithDomain:BGSRNReportErrorDomain code:1\n    userInfo:@{NSLocalizedDescriptionKey : value}];', [O.errorDescription]);
  flagged('a variable description', 'NSString *message = Describe(x);\nNSError *e = [NSError errorWithDomain:BGSRNJSONErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey : message}];', [O.errorDescription]);
  flagged('a formatted description', '[NSError errorWithDomain:BGSRNReportErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey : [NSString stringWithFormat:@"got %@", severity]}];', [O.errorDescription]);
  flagged('a description concatenated after a literal', '[NSError errorWithDomain:D code:1 userInfo:@{NSLocalizedDescriptionKey : @"bad " @"x", NSLocalizedDescriptionKey : name}];', [O.errorDescription]);
  flagged('a userInfo built elsewhere', 'NSError *e = [NSError errorWithDomain:BGSRNReportErrorDomain code:1 userInfo:info];', [O.opaqueUserInfo]);
  flagged('an init with a userInfo built elsewhere', 'NSError *e = [[NSError alloc] initWithDomain:BGSRNReportErrorDomain code:1 userInfo:Info()];', [O.opaqueUserInfo]);
  flagged('a description set by subscript', 'info[NSLocalizedDescriptionKey] = value;', [O.errorDescription]);
  flagged('a description set with setObject:forKey:', '[info setObject:@"x" forKey:NSLocalizedDescriptionKey];', [O.errorDescription]);
  flagged('an identifier entry holding a value', '[NSError errorWithDomain:D code:1 userInfo:@{NSLocalizedDescriptionKey : @"bad {identifier}", BGSRNErrorIdentifierKey : value}];', [O.identifier]);
  flagged('a description read outside the reader', 'NSString *d = info[NSLocalizedDescriptionKey];', [O.errorDescription]);
  flagged('the audited helper, in another file', 'NSString *BGSRNErrorMessage(NSError *error) {\n  return error.localizedDescription;\n}', [O.localizedDescription]);
  flagged(
    'a read outside the helper, in the helper\'s own file',
    'NSString *BGSRNErrorMessage(NSError *error) {\n  return @"x";\n}\nNSString *Other(NSError *e) {\n  return e.localizedDescription;\n}', [O.localizedDescription],
    'BGSRNErrorMessage.m',
  );
  flagged(
    'a reason read inside the helper',
    'NSString *BGSRNErrorMessage(NSError *error) {\n  return exception.reason;\n}', [O.reason],
    'BGSRNErrorMessage.m',
  );

  allowed('NSStringFromClass(exception.class)', objcCatch('NSLog(@"%@", NSStringFromClass(exception.class));'));
  allowed('[exception class]', objcCatch('NSLog(@"%@", NSStringFromClass([exception class]));'));
  allowed('exception.name', objcCatch('NSLog(@"%@", exception.name);'));
  allowed('[exception name]', objcCatch('NSLog(@"%@", [exception name]);'));
  allowed('BGSRNRejectException(reject, op, exception)', objcCatch('BGSRNRejectException(reject, @"reportRead", exception);'));
  allowed('typeid(e) in a C++ catch', cppCatch('NSLog(@"%s", typeid(e).name());'));
  allowed('a bridge error through BGSRNErrorMessage', 'NSError *error = nil;\nreject(BGSRNReportErrorWireCode(error), BGSRNErrorMessage(error), nil);');
  allowed('an error domain and code', 'NSError *error = nil;\nNSLog(@"%@ %ld", error.domain, (long)[error code]);');
  allowed('an out-parameter inside a format call', 'NSError *error = nil;\nNSLog(@"%@", Parse(json, &error));');
  allowed('the audited helper in BGSRNErrorMessage.m', 'NSString *BGSRNErrorMessage(NSError *error) {\n  return error.userInfo[NSLocalizedDescriptionKey] ?: error.localizedDescription;\n}', 'BGSRNErrorMessage.m');
  flagged('a userInfo built elsewhere, after a nested send and call', '[NSError errorWithDomain:[self domain] code:Code(a, b) userInfo:info];\n[NSError errorWithDomain : D code:1 userInfo:info];', [O.opaqueUserInfo, O.opaqueUserInfo]);
  flagged('an unspaced identifier entry holding a value', 'x = @{NSLocalizedDescriptionKey : @"a {identifier}", BGSRNErrorIdentifierKey:value};', [O.identifier]);
  flagged('a description whose value runs on past a nested call', 'x = @{NSLocalizedDescriptionKey : Pick(@"a", value), K : v};', [O.errorDescription]);
  flagged('an audited reject helper that is only a suffix', 'reject(code, flag ?: BGSRNErrorMessage(error), nil);\nreject(nil, flag ?: [BGSRNReportOps failureMessageForOperation:operation], nil);\nreject(nil, [BGSRNReportOps failureMessageForOperation:operation].uppercaseString, nil);', [O.rejectArg, O.rejectArg, O.rejectArg]);
  allowed('a parenthesised literal description before another entry', '[NSError errorWithDomain:D code:1 userInfo:@{NSLocalizedDescriptionKey : (@"a"), NSUnderlyingErrorKey : Make(a, b)}];');
  allowed('a description in a nested dictionary entry', 'x = @{K : @[ @{NSLocalizedDescriptionKey : @"a"} ], NSLocalizedDescriptionKey : @"b"};');
  allowed('a construction with no userInfo', '[[NSError alloc] initWithDomain:D code:1];');
  allowed('a reject passing the operation through', 'reject(nil, operation, nil);');
  allowed('a literal description', 'Fail(error, [NSError errorWithDomain:BGSRNReportErrorDomain\n    code:BGSRNReportErrorBadArgument\n    userInfo:@{NSLocalizedDescriptionKey : @"labels must all be strings"}]);');
  allowed('a description that is a named constant', '[NSError errorWithDomain:D code:1 userInfo:@{ NSLocalizedDescriptionKey : kMalformedJSON }];');
  allowed('an identifier entry naming the key, and an underlying error', '[NSError errorWithDomain:D code:1 userInfo:@{\n  NSLocalizedDescriptionKey : @"unknown key \\"{identifier}\\"",\n  BGSRNErrorIdentifierKey : key,\n  NSUnderlyingErrorKey : parseError ?: NSNull.null,\n}];');
  allowed('a nil userInfo, and an init', '[NSError errorWithDomain:D code:1 userInfo:nil];\n[[NSError alloc] initWithDomain:D code:2 userInfo:@{NSLocalizedDescriptionKey : @"x"}];');
  allowed('the reader reading the description', 'NSString *BGSRNErrorMessage(NSError *error) {\n  id d = error.userInfo[NSLocalizedDescriptionKey];\n  return d;\n}', 'BGSRNErrorMessage.m');
  allowed('a userInfo: selector label', '[NSError errorWithDomain:D code:1 userInfo:@{NSLocalizedDescriptionKey : @"m"}];');
  allowed('a description: selector label', '[Bugsee startSpanWithOperation:operation description:description];');
  allowed('concatenated literals in a reject', 'reject(kHandleDeadCode, @"no longer " @"valid", nil);');
  allowed('a reject with a fixed failure message', 'reject(nil, [BGSRNReportOps failureMessageForOperation:operation], nil);');
  allowed('a reject naming the attribute', 'reject(kAttributeRejectedCode, [NSString stringWithFormat:@"attribute \\"%@\\" was not kept", name], nil);');
  allowed('a reject passing the code through', 'reject(code, BGSRNErrorMessage(error), nil);');

  it('labels each rule', () => {
    expect(rulesOf(scanObjC('A.m', 'x = e.localizedDescription; y = [e userInfo];'))).toEqual([
      'localizedDescription read outside BGSRNErrorMessage',
      'userInfo read outside BGSRNErrorMessage',
    ]);
    expect(rulesOf(scanObjC('A.m', 'a = e.reason; b = e.localizedFailureReason; c = e.localizedRecoverySuggestion;'))).toEqual([
      'NSException reason read',
      'localizedFailureReason read',
      'localizedRecoverySuggestion read',
    ]);
    expect(rulesOf(scanObjC('A.m', 'a = e.debugDescription; b = e.description; c = e.callStackSymbols; d = e.what();'))).toEqual([
      'debugDescription read',
      'description read',
      'exception call stack read',
      'std::exception::what() read',
    ]);
    expect(rulesOf(scanObjC('A.m', objcCatch('Use(exception);')))).toEqual([
      'caught NSException `exception` used other than by its class/name or BGSRNRejectException',
    ]);
    expect(rulesOf(scanObjC('A.mm', cppCatch('Use(e);')))).toEqual([
      'caught C++ exception `e` used other than by typeid()',
    ]);
    expect(rulesOf(scanObjC('A.m', 'NSError *error;\nNSLog(@"%@", error);'))).toEqual([
      'NSError/NSException `error` formatted into a log, format or reject call',
    ]);
    expect(rulesOf(scanObjC('A.m', 'reject(@"C", @"m", error);'))).toEqual([
      "reject's third argument is not nil (RN serialises the NSError's userInfo into JS)",
      'a reject argument other than a literal, an identifier or an audited message',
    ]);
    expect(rulesOf(scanObjC('A.m', '[NSError errorWithDomain:D code:1 userInfo:info];\nx = @{NSLocalizedDescriptionKey : v, BGSRNErrorIdentifierKey : v};'))).toEqual([
      'an NSError built with a userInfo the scanner cannot see (nil or a dictionary literal only)',
      'an NSError description that is not a string literal or a named constant',
      'a BGSRNErrorIdentifierKey entry that is not the identifier `key`',
    ]);
  });

  flagged('a catch spread out', '@try {\n} @catch  (  NSException  *  boom  )  {\n  Use(boom);\n}', [O.caught('boom')]);
  flagged('a C++ catch spread out', 'try {\n} catch  (  std::exception  &  boom  )  {\n  Use(boom);\n}', [O.cpp('boom')]);
  flagged('spaced reads', 'a = e . what  (  ); b = [e   reason]; c = e.  userInfo;', [O.userInfo, O.reason, O.what]);
  flagged('an NSError after a nested message in a format call', 'NSError *error;\nNSString *s = [NSString stringWithFormat:@"%@ %@", [a b], error];', [O.formatted('error')]);
  flagged('an NSError after a nested call in a format call', 'NSError *error;\nNSString *s = [NSString stringWithFormat:@"%@ %@", Name(a), error];', [O.formatted('error')]);
  flagged('a spaced NSError declaration', 'NSError  *   error;\nNSLog(@"%@", error);', [O.formatted('error')]);
  flagged('a nullable out-parameter', '- (BOOL)go:(NSError * _Nullable __autoreleasing *)outError {\n  NSLog(@"%@", *outError);\n}', [O.formatted('outError')]);
  flagged('spaced reject and construction', 'reject  (@"C", @"m", error);\n[NSError   errorWithDomain:D code:1 userInfo  :  info];\nx = @{ NSLocalizedDescriptionKey   :   v };', [O.thirdArgument, O.rejectArg, O.opaqueUserInfo, O.errorDescription]);
  flagged('a reject with two arguments, the second a value', 'reject(code, value);', [O.rejectArg]);
  flagged('an audited helper call that is only a prefix', 'reject(code, BGSRNErrorMessage(error) ?: value, nil);', [O.rejectArg]);
  flagged('a failure-message send that is only a prefix', 'reject(nil, [BGSRNReportOps failureMessageForOperation:op].lowercaseString, nil);', [O.rejectArg]);
  flagged('a format send that is only a prefix', 'reject(nil, [NSString stringWithFormat:@"%@", name].lowercaseString, nil);', [O.rejectArg]);
  flagged('a failure message for something other than the operation', 'reject(nil, [BGSRNReportOps failureMessageForOperation:summary], nil);', [O.rejectArg]);
  allowed('a spaced failure-message send', 'reject(nil, [BGSRNReportOps   failureMessageForOperation:operation], nil);');
  allowed('a spaced format send', 'reject(nil, [NSString   stringWithFormat:@"%@", name], nil);');
  allowed('a failure message for a literal operation', 'reject(nil, [BGSRNReportOps failureMessageForOperation:@"reportRead"], nil);');
  allowed('a class or domain read with spaces', 'NSError *error;\nNSLog(@"%@ %@", error .  domain, [  error   code  ]);');
  allowed('the audited helper in BGSRNErrorMessage.m with a nested path', 'NSString *BGSRNErrorMessage(NSError *error) {\n  return error.userInfo[NSLocalizedDescriptionKey];\n}', 'Support/Sources/BGSRNErrorMessage.m');

  it('reports the raw source of each construction rule', () => {
    expect(scanObjC('A.m', '[NSError errorWithDomain:D code:1 userInfo:info];\nx = @{NSLocalizedDescriptionKey : v, BGSRNErrorIdentifierKey : v};\nreject(c, @"m", e);')).toEqual([
      expect.objectContaining({ line: 3, snippet: 'reject(c, @"m", e)', rule: O.thirdArgument }),
      expect.objectContaining({ line: 3, snippet: 'reject(c, @"m", e)', rule: O.rejectArg }),
      expect.objectContaining({ line: 1, snippet: 'errorWithDomain:' }),
      expect.objectContaining({ line: 2, snippet: 'NSLocalizedDescriptionKey' }),
      expect.objectContaining({ line: 2, snippet: 'BGSRNErrorIdentifierKey :' }),
    ]);
  });

  it('reports the line and the raw source of a whitelist violation', () => {
    expect(scanObjC('A.m', objcCatch('NSLog(@"s3cret: %@", exception);'))[0]).toEqual({
      file: 'A.m',
      line: 4,
      rule: 'caught NSException `exception` used other than by its class/name or BGSRNRejectException',
      snippet: 'NSLog(@"s3cret: %@", exception);',
    });
  });
});

describe('scanTs', () => {
  const flagged = (label: string, source: string, rules: string[]): void => {
    it(`flags: ${label}`, () => {
      expect(rulesOf(scanTs('fixture.ts', source))).toEqual(rules);
    });
  };
  const allowed = (label: string, source: string): void => {
    it(`allows: ${label}`, () => {
      expect(scanTs('fixture.ts', source)).toEqual([]);
    });
  };

  flagged('a value interpolated into an error', 'throw new TypeError(`bad ${value}`);', [T.sink]);
  flagged('JSON.stringify of a value', 'throw new RangeError(`bad ${JSON.stringify(color)}`);', [T.sink]);
  flagged('String() of a value', 'throw new RangeError(`bad ${String(level)}`);', [T.sink]);
  flagged('a value concatenated into badArgument', "badArgument('bad ' + value);", [T.sink]);
  flagged('an error object handed to console', "console.warn('[Bugsee] threw', error);", [T.sink]);
  flagged('a value handed to reject', 'reject(value);', [T.sink]);
  flagged('a cause carried on an error', "throw new Error('failed', { cause: error });", [T.sink]);
  flagged('a ternary inside an interpolation', "throw new TypeError(`got ${Array.isArray(x) ? 'array' : typeof x}`);", [T.sink]);
  flagged('a file path, which is not an identifier', 'throw new Error(`bad ${path}`);', [T.sink]);
  flagged('another function forwarding a message', 'function other(error: unknown): unknown {\n  return new BugseeReportError(code, message);\n}', [T.sink]);

  flagged('a thrown object literal', 'throw { message: value };\nthrow{ message: v };', ['a thrown object literal (its fields are not checked)', 'a thrown object literal (its fields are not checked)']);
  flagged('console called by subscript', "console['warn']('x', value);\nconsole [ 'error' ] (value);", [T.sink, T.sink]);
  allowed('console taken by subscript, not called', 'const original = console[method].bind(console);\nconsole[method] = wrapped;');
  allowed('typeof in an interpolation', 'throw new TypeError(`got ${typeof value}`);');
  allowed('describeType in an interpolation', 'throw new TypeError(`got ${describeType(value)}`);');
  allowed('errorName for console', "console.warn('[Bugsee] threw', errorName(error));");
  allowed('exceptionOptionsMessage for console', "console.warn('[Bugsee] options rejected', exceptionOptionsMessage(cause));");
  allowed('identifier names', 'throw new TypeError(`Bugsee.${method} ${name} ${key} ${field} ${kind} ${keyPath}[${i}] ${index} ${platform}`);');
  allowed('constants and an enum member', 'throw new BugseeReportError(ReportErrorCode.BadArgument, `at most ${MAX_LENGTH}`);');
  allowed('no arguments, and a trailing comma', "throw new Error();\nthrow new TypeError(\n  'fixed',\n);");
  allowed('literal concatenation', "throw new Error('a ' + 'b' + `c`);");
  allowed(
    'the badArgument helper forwarding its parameter',
    'function badArgument(message: string): never {\n  throw new BugseeReportError(ReportErrorCode.BadArgument, message);\n}',
  );
  allowed(
    'toReportError forwarding a native message',
    'export function toReportError(error: unknown): unknown {\n  return new BugseeReportError(code, typeof message === "string" ? message : code);\n}',
  );
  allowed(
    'toAttributeError forwarding a native message',
    'function toAttributeError(error: unknown): unknown {\n  return new BugseeAttributeError(code, message);\n}',
  );

  flagged('spaced sinks', "throw   new   TypeError  (value);\nconsole . warn  ('x', error);\nbadArgument  (v);\nreject  (v);", [T.sink, T.sink, T.sink, T.sink]);
  flagged('a typeof that is only a prefix', 'throw new TypeError(`got ${typeof value === "x" ? a : b}`);', [T.sink]);
  allowed('a spaced typeof and a dotted describeType', 'throw new TypeError(`got ${typeof  value} ${describeType(a.b)} ${typeof event.url}`);');
  allowed('a parenthesised message', "throw new TypeError(('a ' + name));");

  it('labels the rule, with the line and the raw source', () => {
    expect(scanTs('a.ts', '\nthrow new TypeError(`s3cret ${value}`);')).toEqual([
      {
        file: 'a.ts',
        line: 2,
        rule: 'an error or console message built from something other than literals, identifiers and type names',
        snippet: 'new TypeError(`s3cret ${value}`)',
      },
    ]);
  });
});

describe('scannerFor', () => {
  it('routes each understood language to its scanner, by root', () => {
    expect(scannerFor('a/A.java', 'android')).toBe(scanJava);
    expect(scannerFor('a/B.m', 'ios')).toBe(scanObjC);
    expect(scannerFor('B.mm', 'ios')).toBe(scanObjC);
    expect(scannerFor('B.h', 'ios')).toBe(scanObjC);
    expect(scannerFor('c.ts', 'src')).toBe(scanTs);
    expect(scannerFor('c.tsx', 'src')).toBe(scanTs);
  });

  it('skips build scripts and data files', () => {
    for (const [file, kind] of [
      ['ios/Package.swift', 'ios'],
      ['ios/Package.resolved', 'ios'],
      ['android/build.gradle', 'android'],
      ['android/build.gradle.kts', 'android'],
      ['android/settings.gradle.kts', 'android'],
      ['android/proguard-rules.pro', 'android'],
      ['android/src/main/AndroidManifest.xml', 'android'],
      ['android/gradle.properties', 'android'],
      ['android/x.json', 'android'],
      ['ios/x.json', 'ios'],
      ['src/options/keys.json', 'src'],
    ] as const) {
      expect([file, scannerFor(file, kind)]).toEqual([file, null]);
    }
  });

  it('refuses the languages it does not understand, wherever they sit', () => {
    expect(scannerFor('ios/Bridge.swift', 'ios')).toBe(
      'Swift source: the raw-message scanner does not understand Swift yet ' +
        '(string interpolation, catch syntax), so it cannot vouch for this file',
    );
    expect(scannerFor('android/MyPackage.swift', 'android')).toMatch(/^Swift source/);
    expect(scannerFor('android/src/main/kotlin/A.kt', 'android')).toMatch(/^Kotlin source: .* does not understand Kotlin yet/);
    expect(scannerFor('android/src/main/kotlin/Gen.kts', 'android')).toMatch(/^Kotlin source/);
    expect(scannerFor('android/src/main/cpp/a.c', 'android')).toMatch(/^C source/);
    expect(scannerFor('android/src/main/cpp/jni.h', 'android')).toMatch(/^C source/);
    for (const ext of ['.cc', '.cpp', '.cxx']) {
      expect(scannerFor(`ios/glue${ext}`, 'ios')).toMatch(/^C\+\+ source/);
      expect(scannerFor(`android/glue${ext}`, 'android')).toMatch(/^C\+\+ source/);
    }
  });

  it('refuses any other file kind until someone decides', () => {
    expect(scannerFor('ios/thing.plist', 'ios')).toBe(
      'unknown file kind ".plist" under ios/: decide whether it is runtime code and teach the scanner',
    );
    expect(scannerFor('src/index.js', 'src')).toMatch(/^unknown file kind "\.js" under src\//);
    expect(scannerFor('android/A.m', 'android')).toMatch(/^unknown file kind "\.m" under android\//);
    expect(scannerFor('android/x.ts', 'android')).toMatch(/^unknown/);
  });
});

describe('walk and scanPackages', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raw-messages-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const put = (path: string, text = ''): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  const listed = (dir: string): string[] =>
    walk(join(root, dir)).map((f) => `${relative(root, f.path)}${f.test ? ' (test)' : ''}`).sort();

  it('skips build output only beside the build file that makes it, and node_modules anywhere', () => {
    put('android/build.gradle');
    put('android/build/out.java');
    put('android/.gradle/x.java');
    put('android/.cxx/x.cpp');
    put('android/src/main/java/com/x/build/Runtime.java');
    put('android/src/main/java/node_modules/x.java');
    put('ios/Support/Package.swift');
    put('ios/Support/.build/x.m');
    put('ios/Support/.swiftpm/x.m');
    put('ios/build/Runtime.m');
    put('ios/Tests/NotATestBundle.m');
    put('kts/build.gradle.kts');
    put('kts/build/out.java');
    put('kts/.gradle/x.java');
    put('kts/.cxx/x.cpp');
    put('kts/src/main/java/A.java');
    expect(listed('android')).toEqual([
      'android/build.gradle',
      'android/src/main/java/com/x/build/Runtime.java',
    ]);
    expect(listed('ios')).toEqual(['ios/Support/Package.swift', 'ios/Tests/NotATestBundle.m', 'ios/build/Runtime.m']);
    expect(listed('kts')).toEqual(['kts/build.gradle.kts', 'kts/src/main/java/A.java']);
  });

  it('marks test source sets: Gradle src/test* and src/androidTest*, SwiftPM Tests, Jest __tests__/__mocks__', () => {
    put('android/build.gradle.kts');
    put('android/src/test/java/T.java');
    put('android/src/testDebug/java/T.java');
    put('android/src/androidTest/java/T.java');
    put('android/src/main/java/com/x/test/Runtime.java');
    put('android/src/latest/java/Runtime.java');
    put('android/test/Runtime.java');
    put('ios/Support/Package.swift');
    put('ios/Support/Tests/T.m');
    put('ios/Support/Sources/Tests/Runtime.m');
    put('src/a/__tests__/a.test.ts');
    put('src/__mocks__/m.ts');
    put('src/testSupport/s.ts');
    expect(listed('android')).toEqual([
      'android/build.gradle.kts',
      'android/src/androidTest/java/T.java (test)',
      'android/src/latest/java/Runtime.java',
      'android/src/main/java/com/x/test/Runtime.java',
      'android/src/test/java/T.java (test)',
      'android/src/testDebug/java/T.java (test)',
      'android/test/Runtime.java',
    ]);
    expect(listed('ios')).toEqual([
      'ios/Support/Package.swift',
      'ios/Support/Sources/Tests/Runtime.m',
      'ios/Support/Tests/T.m (test)',
    ]);
    expect(listed('src')).toEqual(['src/__mocks__/m.ts (test)', 'src/a/__tests__/a.test.ts (test)', 'src/testSupport/s.ts']);
  });

  const leakyJava = 'try { a(); } catch (RuntimeException e) { p.reject("E", e.getMessage()); }';

  // Review I1: the reviewer's three scratch cases, which passed the old roots.
  it('refuses Kotlin in src/main/kotlin, flags a leak in src/newarch, refuses an unscanned shipped cpp/', () => {
    put('packages/lib/package.json', JSON.stringify({ files: ['src', 'android', 'ios', 'cpp', 'plugin/build', 'scripts/x.js', '*.podspec', 'README.md'] }));
    put('packages/lib/android/build.gradle');
    put('packages/lib/android/src/main/java/com/x/C.java', 'class C {}');
    put('packages/lib/android/src/main/kotlin/com/x/A.kt', 'catch (e: Exception) { Log.w("T", "x $e") }');
    put('packages/lib/android/src/newarch/java/com/x/B.java', leakyJava);
    put('packages/lib/cpp/D.cpp', 'printf("%s", e.what());');
    put('packages/lib/plugin/build/index.js', 'console.log(process.argv[2]);');
    put('packages/lib/scripts/x.js', 'console.log(process.argv[2]);');
    put('packages/lib/README.md');
    const scan = scanPackages(join(root, 'packages'), root);
    expect(scan.roots).toEqual(['packages/lib/android']);
    expect(scan.refused).toEqual([
      expect.stringMatching(/^packages\/lib\/android\/src\/main\/kotlin\/com\/x\/A\.kt: Kotlin source/),
      'packages/lib/cpp: a shipped directory the raw-message scanner does not cover',
    ]);
    expect(scan.violations.map((v) => `${v.file}:${v.line}`)).toEqual([
      'packages/lib/android/src/newarch/java/com/x/B.java:1',
      'packages/lib/android/src/newarch/java/com/x/B.java:1',
    ]);
  });

  it('takes every top-level directory of a package without a files list, and skips non-packages', () => {
    put('packages/bare/package.json', '{}');
    put('packages/bare/src/a.ts', 'throw new Error(`x ${value}`);');
    put('packages/bare/cpp/D.cpp');
    put('packages/bare/node_modules/dep/index.js');
    put('packages/bare/index.js');
    put('packages/not-a-package/src/a.ts', 'throw new Error(`x ${value}`);');
    const scan = scanPackages(join(root, 'packages'), root);
    expect(scan.roots).toEqual(['packages/bare/src']);
    expect(scan.refused).toEqual(['packages/bare/cpp: a shipped directory the raw-message scanner does not cover']);
    expect(scan.violations.map((v) => v.file)).toEqual(['packages/bare/src/a.ts']);
  });

  it('checks the language of a test source set but does not leak-scan it', () => {
    put('packages/lib/package.json', JSON.stringify({ files: ['android', 'ios', 'src'] }));
    put('packages/lib/android/build.gradle');
    put('packages/lib/android/src/test/java/T.java', leakyJava);
    put('packages/lib/android/src/test/kotlin/T.kt');
    put('packages/lib/ios/Package.swift');
    put('packages/lib/ios/Tests/T.m', 'NSString *m = error.localizedDescription;');
    put('packages/lib/src/__tests__/a.test.ts', "console.warn('x', error);");
    const scan = scanPackages(join(root, 'packages'), root);
    expect(scan.roots).toEqual(['packages/lib/android', 'packages/lib/ios', 'packages/lib/src']);
    expect(scan.refused).toEqual([expect.stringMatching(/^packages\/lib\/android\/src\/test\/kotlin\/T\.kt: Kotlin source/)]);
    expect(scan.violations).toEqual([]);
  });
});
