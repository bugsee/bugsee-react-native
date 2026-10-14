/**
 * What drives each native `Animated.Value`, as far as JS can know it.
 *
 * Natively, a value moves by an animation (which JS starts, and which hands
 * JS its end value) or by a native event attached to it (a scroll, a
 * gesture), whose values JS never sees. React Native attaches native events
 * two ways: an `Animated` component attaches the `Animated.event`s in its
 * props through `AnimatedEvent.__attach`, and `Animated.attachNativeEvent`
 * attaches a mapping directly (React Native's own ScrollView does, for its
 * sticky headers). Both are followed here, from when the package is first
 * imported (`followEvents.ts`, imported for its effect by the package entry),
 * and so is every value being made native (`AnimatedValue.__makeNative`).
 *
 * A native value is then one of:
 *  - driven by events: some are attached to it now (`eventsOn`), and it is
 *    wherever they take it;
 *  - known: made native while followed (or seen animating) and no event is
 *    attached now: only animations move it, and JS has where they leave it;
 *  - unknown: neither (made native before the package was imported, or its
 *    last event detached), or nothing can be followed (React Native moved
 *    these internals, or an attachment could not be read): anything may
 *    drive it.
 *
 * Patching is global and done once: each object patched carries this state
 * under a symbol (not enumerable), so a second copy of this module (Fast
 * Refresh, two copies of the package) shares it rather than wrapping again.
 * An app that never renders a `<BugseeSecure>` pays a few map updates per
 * attach and detach, and nothing else.
 */

/** A native event attached to a value: the view, the event's name, where in the event the value is. */
export interface Attachment {
  readonly view: unknown;
  readonly event: unknown;
  /** From the event's first argument: `['nativeEvent', 'contentOffset', 'y']`. */
  readonly path: readonly string[];
}

/** An attachment with the value it drives. */
type Attached = Attachment & { readonly value: object };

interface DriverState {
  /** The events attached to each value now (one entry per attachment). */
  readonly attached: WeakMap<object, Attached[]>;
  /** Per `AnimatedEvent`, the attachments of each `__attach` still in place, oldest first. */
  readonly events: WeakMap<object, Attached[][]>;
  /** Values made native while followed, or seen animating, with no event since: only animations move them. */
  readonly known: WeakSet<object>;
  /** Called the moment a value is made native, by value. */
  readonly onNative: WeakMap<object, Set<() => void>>;
  /** An attachment could not be read: which values it drives is not known. */
  lost: boolean;
}

/** Where the state is kept on every object patched, and on every function that wraps one. */
// Stryker disable next-line StringLiteral -- any key nothing else uses
const KEY = Symbol.for('@bugsee/react-native/secure-drivers');

/** The state, while everything is followed; `null`: nothing can be trusted. */
let drivers: DriverState | null = null;

/** How deep in an event's mapping its values are looked for (`{ nativeEvent: { contentOffset: { y } } }`). */
const MAPPING_DEPTH = 8;

/** Anything with React Native's `Animated` node interface. */
export function isNode(value: unknown): value is { __getValue: () => unknown; [field: string]: unknown } {
  return typeof (value as { __getValue?: unknown } | null | undefined)?.__getValue === 'function';
}

/**
 * The `Animated.Value`s in an event's mapping, with where each is (an
 * `Animated.ValueXY`'s two at `x` and `y`), as React Native maps them.
 */
function attachmentsIn(mapping: unknown, view: unknown, event: unknown): Attached[] {
  const found: Attached[] = [];
  const visit = (at: unknown, path: string[]): void => {
    if (at === null || typeof at !== 'object' || path.length > MAPPING_DEPTH) {
      return;
    }
    if (isNode(at)) {
      if ('_value' in at) {
        found.push({ value: at, view, event, path });
      } else {
        visit(at.x, [...path, 'x']);
        visit(at.y, [...path, 'y']);
      }
      return;
    }
    for (const [key, inner] of Object.entries(at)) {
      visit(inner, [...path, key]);
    }
  };
  visit(mapping, []);
  return found;
}

function add(state: DriverState, attachments: readonly Attached[]): void {
  for (const attachment of attachments) {
    state.attached.set(attachment.value, [...(state.attached.get(attachment.value) ?? []), attachment]);
    state.known.delete(attachment.value);
  }
}

function remove(state: DriverState, attachments: readonly Attached[]): void {
  for (const attachment of attachments) {
    // Each attachment is removed once, after it was added.
    // Where the last event left it, JS may not know: it stays unknown until an animation moves it.
    state.attached.set(
      attachment.value,
      (state.attached.get(attachment.value) as Attached[]).filter((each) => each !== attachment),
    );
  }
}

/** Reads an attachment's values; one that cannot be read loses track of every value. */
function read(state: DriverState, mapping: () => unknown, view: unknown, event: unknown): Attached[] {
  try {
    return attachmentsIn(mapping(), view, event);
  } catch {
    state.lost = true;
    return [];
  }
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

function mark<T extends object>(target: T, state: DriverState): T {
  // Not enumerable (the default): spreading the object copies no state.
  Object.defineProperty(target, KEY, { value: state });
  return target;
}

function stateOn(target: object | undefined): DriverState | undefined {
  return (target as { [KEY]?: DriverState } | undefined)?.[KEY];
}

function wrapEvents(prototype: Record<string, unknown>, state: DriverState): void {
  const attach = prototype.__attach as Method;
  const detach = prototype.__detach as Method;
  prototype.__attach = mark(function (this: { _argMapping?: unknown }, ...args: unknown[]) {
    const result = attach.apply(this, args);
    const attachments = read(state, () => (this._argMapping as unknown[] | undefined)?.[0], args[0], args[1]);
    add(state, attachments);
    state.events.set(this, [...(state.events.get(this) ?? []), attachments]);
    return result;
  }, state);
  prototype.__detach = mark(function (this: object, ...args: unknown[]) {
    // Detached with nothing attached: nothing to count. (A string in either list counts no object.)
    // Stryker disable next-line ArrayDeclaration
    const [attachments = [], ...rest] = state.events.get(this) ?? [];
    state.events.set(this, rest);
    remove(state, attachments);
    return detach.apply(this, args);
  }, state);
  mark(prototype, state);
}

function wrapAttach(target: Record<string, unknown>, state: DriverState): void {
  const attachNativeEvent = target.attachNativeEvent as Method;
  target.attachNativeEvent = mark(function (this: unknown, ...args: unknown[]) {
    const handle = attachNativeEvent.apply(this, args) as { detach?: unknown } | null | undefined;
    const attachments = read(state, () => (args[2] as unknown[] | null | undefined)?.[0], args[0], args[1]);
    add(state, attachments);
    // A handle that cannot be wrapped keeps them counted for good: covered, never trusted.
    try {
      const detach = (handle as { detach: Method }).detach;
      (handle as { detach: Method }).detach = function (this: unknown, ...rest: unknown[]) {
        // Detached again: its attachments are gone already, and removing them again removes nothing.
        remove(state, attachments);
        return detach.apply(this, rest);
      };
    } catch {
      // Kept counted.
    }
    return handle;
  }, state);
  mark(target, state);
}

function wrapNative(prototype: Record<string, unknown>, state: DriverState): void {
  const makeNative = prototype.__makeNative as Method;
  prototype.__makeNative = mark(function (this: { __isNative?: unknown }, ...args: unknown[]) {
    const becoming = this.__isNative !== true;
    const result = makeNative.apply(this, args);
    if (becoming) {
      state.known.add(this);
      state.onNative.get(this)?.forEach((wake) => {
        try {
          wake();
        } catch {
          // A watcher's failure is its own; React Native's animation goes on.
        }
      });
    }
    return result;
  }, state);
  mark(prototype, state);
}

/** What React Native has to follow; each from its own module. */
export interface DriverSources {
  /** The `AnimatedEvent` class. */
  readonly eventClass: unknown;
  /** `AnimatedImplementation`: what ScrollView calls `attachNativeEvent` on. */
  readonly implementation: unknown;
  /** The public `Animated` object (a copy of `AnimatedImplementation`'s fields), where it can be loaded. */
  readonly exported?: unknown;
  /** The `AnimatedValue` class. */
  readonly valueClass: unknown;
}

function prototypeOf(type: unknown): unknown {
  return (type as { prototype?: unknown } | null | undefined)?.prototype;
}

function withMethods(target: unknown, ...names: string[]): Record<string, unknown> | undefined {
  const record = target as Record<string, unknown> | null | undefined;
  return record != null && names.every((name) => typeof record[name] === 'function') ? record : undefined;
}

/**
 * Follows what drives native values from now on, through `sources`; once
 * per object, sharing the state any earlier copy of this module set up.
 * Anything missing follows nothing: no still native value is trusted.
 * Returns whether everything is followed.
 */
export function followDrivers(sources: DriverSources): boolean {
  const events = withMethods(prototypeOf(sources.eventClass), '__attach', '__detach');
  const values = withMethods(prototypeOf(sources.valueClass), '__makeNative');
  const implementation = withMethods(sources.implementation, 'attachNativeEvent');
  if (events === undefined || values === undefined || implementation === undefined) {
    drivers = null;
    return false;
  }
  const exported = withMethods(sources.exported, 'attachNativeEvent');
  const state = [events, values, implementation, exported].map(stateOn).find((found) => found !== undefined) ?? {
    attached: new WeakMap(),
    events: new WeakMap(),
    known: new WeakSet(),
    onNative: new WeakMap(),
    lost: false,
  };
  if (stateOn(events) === undefined) {
    wrapEvents(events, state);
  }
  if (stateOn(values) === undefined) {
    wrapNative(values, state);
  }
  for (const target of [implementation, exported]) {
    // Once per object: a function set over the wrapper since (an app's own, calling ours) is not wrapped again.
    // The public object may hold the wrapper already, spread from `AnimatedImplementation` once it was wrapped.
    const unwrapped = target !== undefined && stateOn(target.attachNativeEvent as object) === undefined;
    if (unwrapped && stateOn(target) === undefined) {
      wrapAttach(target, state);
    }
  }
  drivers = state;
  return true;
}

/** Stops following (nothing is trusted from then on); for tests. */
export function forgetDrivers(): void {
  drivers = null;
}

/**
 * The native events attached to `node` now (none: an empty list), or
 * `undefined` when that cannot be known.
 */
export function eventsOn(node: object): readonly Attachment[] | undefined {
  if (drivers === null || drivers.lost) {
    return undefined;
  }
  return drivers.attached.get(node) ?? [];
}

/** Whether only animations have moved `node` since it was made native, as far as followed. */
export function knownDriven(node: object): boolean {
  return drivers?.known.has(node) === true;
}

/** `node` is seen animating: from now on, only animations move it until an event is attached. */
export function noteAnimating(node: object): void {
  drivers?.known.add(node);
}

/**
 * Calls `wake` the moment `node` is made native (its first animation or
 * event with the native driver, which commits nothing), until the returned
 * function is called; `undefined` when that is not followed.
 */
export function whenNative(node: object, wake: () => void): (() => void) | undefined {
  const state = drivers;
  if (state === null) {
    return undefined;
  }
  let wakes = state.onNative.get(node);
  if (wakes === undefined) {
    wakes = new Set();
    state.onNative.set(node, wakes);
  }
  const subscription = (): void => wake();
  wakes.add(subscription);
  const from = wakes;
  return () => {
    from.delete(subscription);
  };
}
