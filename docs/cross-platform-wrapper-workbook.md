# Cross-platform wrapper workbook — moved

This workbook now lives in `bugsee/specs`, beside the contracts it teaches you to
implement against:

**`sdk/wrapper-workbook/`** — https://github.com/bugsee/specs (PR #25)

It moved because it is not React Native's document. It is written for the next
wrapper — Flutter, Unity, .NET, Capacitor, Cordova, KMP — and keeping it here
would have meant either a second copy to drift or a reader in another repo not
finding it.

## Keep adding to it

Every trap in it was found by implementing React Native against the 7.x SDKs, and
that work is ongoing. When this wrapper hits something the next one would hit
too, it belongs there, not in a commit message here:

- a contract that could not be implemented from its own documentation
- a failure whose symptom points somewhere other than its cause
- a test or device run that passed while measuring the wrong thing
- a platform difference that a wrapper must absorb rather than expose

The bar is "would another wrapper hit this", not "was it surprising to us".
