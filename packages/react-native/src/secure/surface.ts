import { FiberTag } from '../viewtree/fiber';
import type { FiberLike } from '../viewtree/fiber';

/**
 * Which React surface a view is measured in, read off the fiber tree with
 * no native call.
 *
 * Fabric `measureInWindow` stops at the nearest `RootNodeKind` ancestor. A
 * `<Modal>` is one (`ModalHostViewShadowNode`), and its host fiber is the
 * `RCTModalHostView` component, so a view inside a Modal is measured from
 * that Modal's content and everything else from the app's own root. A
 * surface is named by the Modal host's React tag (Android also gives the
 * Modal's dialog root that id); the app's root is {@link MAIN_SURFACE}.
 * Native translates each surface's rectangles by that surface's own origin.
 */

/** The app's own React root; matches native `MAIN_SURFACE`. */
export const MAIN_SURFACE = 0;

/**
 * A view known to be inside a `<Modal>` whose host's tag cannot be read.
 * Never the main surface: native serves a surface whose origin it cannot
 * find as the whole display.
 */
export const UNKNOWN_MODAL_SURFACE = -1;

/** The host component type of a `<Modal>` (`RCTModalHostViewNativeComponent`). */
export const MODAL_HOST_TYPE = 'RCTModalHostView';

/** A cycle in a malformed tree must not spin forever. */
const MAX_ANCESTORS = 10_000;

/**
 * The native tag of a host fiber, via its public instance (Fabric's carry
 * `__nativeTag`), or `null` when it has none.
 */
export function nativeTagOfFiber(fiber: FiberLike): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, like the view tree's measure: only a real renderer has it.
    const rendererProxy = require('react-native/Libraries/ReactNative/RendererProxy') as {
      getPublicInstanceFromInternalInstanceHandle: (fiber: unknown) => unknown;
    };
    const publicInstance = rendererProxy.getPublicInstanceFromInternalInstanceHandle(fiber);
    const tag = (publicInstance as { __nativeTag?: unknown } | null)?.__nativeTag;
    // Number.isFinite never coerces: a string or a missing tag is not finite.
    return Number.isFinite(tag) ? (tag as number) : null;
  } catch {
    return null;
  }
}

/**
 * The surface `fiber` is measured in: the tag of the nearest `<Modal>` host
 * above it, {@link UNKNOWN_MODAL_SURFACE} when that host has no tag, or
 * {@link MAIN_SURFACE} when there is no Modal above it. `fiber` itself is
 * not considered: a Modal host is measured in its parent's surface.
 */
export function surfaceOfFiber(
  fiber: FiberLike,
  tagOf: (fiber: FiberLike) => number | null = nativeTagOfFiber,
): number {
  let current = fiber.return;
  for (let steps = 0; current != null && steps < MAX_ANCESTORS; steps += 1) {
    if (current.tag === FiberTag.HostComponent && current.type === MODAL_HOST_TYPE) {
      return tagOf(current) ?? UNKNOWN_MODAL_SURFACE;
    }
    current = current.return;
  }
  return MAIN_SURFACE;
}

/**
 * The surface of a mounted host's public instance (Fabric's carries its
 * fiber as `__internalInstanceHandle`). {@link MAIN_SURFACE} when the
 * instance has no fiber, which only a non-Fabric renderer produces.
 */
export function surfaceOfInstance(instance: object): number {
  const fiber = (instance as { __internalInstanceHandle?: unknown }).__internalInstanceHandle;
  if (fiber === null || typeof fiber !== 'object') {
    return MAIN_SURFACE;
  }
  return surfaceOfFiber(fiber as FiberLike);
}
