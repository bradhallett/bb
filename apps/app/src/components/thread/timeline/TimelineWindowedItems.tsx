import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { supportsScrollAnchoring } from "@/lib/scroll-anchoring-support";

/** Rows within this distance of their scrollport stay mounted. */
const TIMELINE_WINDOW_VIEWPORT_MARGIN_PX = 800;
/** Delay geometry-changing fallback work until native momentum has stopped. */
const TIMELINE_WINDOW_IDLE_DELAY_MS = 300;
/** Bound row-local interaction state retained across a long-lived session. */
const TIMELINE_WINDOW_MAX_INTERACTION_PINS = 24;
/** Bound exact-height history retained by a long-lived streaming thread. */
const TIMELINE_WINDOW_MAX_MEASUREMENTS = 2_000;
/** Short lists cost less to keep mounted than to observe and measure. */
export const TIMELINE_WINDOWING_MIN_ITEM_COUNT = 20;

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

function recordTimelineMeasurement(
  measurements: Map<string, number>,
  key: string,
  height: number,
): void {
  measurements.delete(key);
  measurements.set(key, height);
  while (measurements.size > TIMELINE_WINDOW_MAX_MEASUREMENTS) {
    const oldestKey = measurements.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    measurements.delete(oldestKey);
  }
}

export interface TimelineWindowingScrollRoot {
  getScrollElement: () => HTMLElement | null;
}

/**
 * A capped timeline detail body supplies its own scroll root. Lists outside a
 * detail body fall back to the thread's main bottom-anchored scrollport.
 */
export const TimelineWindowingScrollRootContext =
  createContext<TimelineWindowingScrollRoot | null>(null);

/**
 * Measurements survive when a windowed parent unmounts a nested list. The
 * provider is keyed with the owning thread, so stale row ids cannot cross
 * thread boundaries.
 */
export const TimelineWindowingMeasurementsContext = createContext<Map<
  string,
  number
> | null>(null);

export interface TimelineWindowedItemRenderState {
  isRealized: boolean;
  itemRef: (node: HTMLDivElement | null) => void;
  placeholderStyle: CSSProperties | undefined;
  windowingEnabled: boolean;
}

interface TimelineWindowedItemsProps {
  enabled: boolean;
  alwaysMountedKeys?: ReadonlySet<string>;
  estimateItemHeight: (index: number) => number;
  getScrollElement: (() => HTMLElement | null) | null;
  itemKeys: readonly string[];
  measurements: Map<string, number>;
  minItemCount?: number;
  renderItem: (
    index: number,
    state: TimelineWindowedItemRenderState,
  ) => ReactNode;
}

interface TimelineWindowedItemSlotProps {
  estimatedHeight: number;
  index: number;
  isRealized: boolean;
  itemRef: (node: HTMLDivElement | null) => void;
  renderItem: TimelineWindowedItemsProps["renderItem"];
  windowingEnabled: boolean;
}

/**
 * Observer updates usually change only the handful of rows crossing an
 * overscan edge. Keep the other wrappers out of React's render phase: without
 * this boundary, each edge crossing calls `renderItem` for every loaded row
 * even though their props and DOM are unchanged.
 */
const TimelineWindowedItemSlot = memo(function TimelineWindowedItemSlot({
  estimatedHeight,
  index,
  isRealized,
  itemRef,
  renderItem,
  windowingEnabled,
}: TimelineWindowedItemSlotProps) {
  return renderItem(index, {
    isRealized,
    itemRef,
    placeholderStyle:
      windowingEnabled && !isRealized
        ? {
            height: estimatedHeight,
            minHeight: estimatedHeight,
            overflow: "hidden",
          }
        : undefined,
    windowingEnabled,
  });
});

function itemMustRemainMounted(
  element: HTMLElement,
  alwaysMounted: boolean,
  interactionPinned: boolean,
): boolean {
  if (alwaysMounted || interactionPinned) {
    return true;
  }
  if (
    document.activeElement instanceof Node &&
    element.contains(document.activeElement)
  ) {
    return true;
  }
  const selectionAnchor = window.getSelection()?.anchorNode;
  if (selectionAnchor instanceof Node && element.contains(selectionAnchor)) {
    return true;
  }
  return false;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

interface TimelineVisibleAnchor {
  element: HTMLDivElement;
  top: number;
}

function captureVisibleAnchor({
  itemKeys,
  scrollElement,
  wrapperByKey,
}: {
  itemKeys: readonly string[];
  scrollElement: HTMLElement;
  wrapperByKey: ReadonlyMap<string, HTMLDivElement>;
}): TimelineVisibleAnchor | null {
  const scrollRect = scrollElement.getBoundingClientRect();
  let low = 0;
  let high = itemKeys.length - 1;
  let firstVisibleIndex = itemKeys.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const key = itemKeys[middle];
    const element = key === undefined ? undefined : wrapperByKey.get(key);
    if (element === undefined) {
      return null;
    }
    if (element.getBoundingClientRect().bottom > scrollRect.top) {
      firstVisibleIndex = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const key = itemKeys[firstVisibleIndex];
  const element = key === undefined ? undefined : wrapperByKey.get(key);
  if (element === undefined) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return rect.top < scrollRect.bottom ? { element, top: rect.top } : null;
}

function restoreVisibleAnchor({
  anchor,
  scrollElement,
  wasAtBottom,
}: {
  anchor: TimelineVisibleAnchor | null;
  scrollElement: HTMLElement;
  wasAtBottom: boolean;
}): void {
  if (wasAtBottom) {
    scrollElement.scrollTop = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.clientHeight,
    );
    return;
  }
  if (anchor === null || !anchor.element.isConnected) {
    return;
  }
  const topDelta = anchor.element.getBoundingClientRect().top - anchor.top;
  if (Math.abs(topDelta) > 0.5) {
    scrollElement.scrollTop += topDelta;
  }
}

/**
 * Normal-flow timeline windowing.
 *
 * Every item keeps one stable wrapper in document order. Rows near the active
 * scrollport mount their real React subtree; distant rows become measured (or
 * estimated) fixed-height wrappers. Keeping wrappers instead of absolutely
 * positioning rows preserves the timeline's row-id DOM contract, native
 * search/TOC scrolling, flex gaps, nested group lines, and prepend anchoring.
 */
export function TimelineWindowedItems({
  enabled,
  alwaysMountedKeys = EMPTY_KEY_SET,
  estimateItemHeight,
  getScrollElement,
  itemKeys,
  measurements,
  minItemCount = TIMELINE_WINDOWING_MIN_ITEM_COUNT,
  renderItem,
}: TimelineWindowedItemsProps) {
  const windowingEnabled =
    enabled && itemKeys.length >= minItemCount && getScrollElement !== null;
  const [realizedKeys, setRealizedKeys] =
    useState<ReadonlySet<string>>(EMPTY_KEY_SET);
  const wrapperByKeyRef = useRef(new Map<string, HTMLDivElement>());
  const keyByWrapperRef = useRef(new Map<Element, string>());
  const wrapperRefCallbacksRef = useRef(
    new Map<string, (node: HTMLDivElement | null) => void>(),
  );
  const lastVisualHeightByKeyRef = useRef(new Map<string, number>());
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const alwaysMountedKeysRef = useRef(alwaysMountedKeys);
  const itemKeysRef = useRef(itemKeys);
  const pinnedKeysRef = useRef<string[]>([]);
  const pinnedKeySetRef = useRef(new Set<string>());
  alwaysMountedKeysRef.current = alwaysMountedKeys;
  itemKeysRef.current = itemKeys;

  const keySignature = useMemo(() => itemKeys.join("\u0000"), [itemKeys]);
  const indexByKey = useMemo(
    () => new Map(itemKeys.map((key, index) => [key, index])),
    // Key order is the entire map input; streaming content updates keep this
    // primitive stable and therefore do not recreate the observers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keySignature],
  );

  const getWrapperRefCallback = useCallback((key: string) => {
    const callbacks = wrapperRefCallbacksRef.current;
    let callback = callbacks.get(key);
    if (callback === undefined) {
      callback = (node: HTMLDivElement | null) => {
        const previous = wrapperByKeyRef.current.get(key);
        if (previous !== undefined && previous !== node) {
          keyByWrapperRef.current.delete(previous);
          intersectionObserverRef.current?.unobserve(previous);
          resizeObserverRef.current?.unobserve(previous);
        }
        if (node === null) {
          wrapperByKeyRef.current.delete(key);
          return;
        }
        wrapperByKeyRef.current.set(key, node);
        keyByWrapperRef.current.set(node, key);
        lastVisualHeightByKeyRef.current.set(
          key,
          node.getBoundingClientRect().height,
        );
        intersectionObserverRef.current?.observe(node);
        resizeObserverRef.current?.observe(node);
      };
      callbacks.set(key, callback);
    }
    return callback;
  }, []);

  // Promote the initial viewport before paint and prune state when pagination
  // or a history rewrite changes the key set. Detached/test surfaces render in
  // full so snapshots and embedded consumers never see empty placeholders.
  useLayoutEffect(() => {
    if (!windowingEnabled) {
      setRealizedKeys((previous) =>
        previous.size === 0 ? previous : EMPTY_KEY_SET,
      );
      return;
    }

    const currentItemKeys = itemKeysRef.current;
    const keySet = new Set(currentItemKeys);
    for (const staleMap of [
      wrapperRefCallbacksRef.current,
      lastVisualHeightByKeyRef.current,
    ] as const) {
      for (const key of staleMap.keys()) {
        if (!keySet.has(key)) {
          staleMap.delete(key);
        }
      }
    }
    pinnedKeysRef.current = pinnedKeysRef.current.filter((key) =>
      keySet.has(key),
    );
    pinnedKeySetRef.current = new Set(pinnedKeysRef.current);

    const collectRealizedKeys = (
      previous: ReadonlySet<string>,
      scrollElement: HTMLElement | null,
    ): ReadonlySet<string> => {
      const next = new Set<string>();
      for (const key of previous) {
        if (keySet.has(key)) {
          next.add(key);
        }
      }
      for (const key of alwaysMountedKeys) {
        if (keySet.has(key)) {
          next.add(key);
        }
      }

      const promoteAll =
        scrollElement === null ||
        scrollElement.clientHeight === 0 ||
        typeof IntersectionObserver === "undefined";
      if (promoteAll) {
        for (const key of currentItemKeys) {
          next.add(key);
        }
      } else {
        const viewport = scrollElement.getBoundingClientRect();
        const viewportTop = viewport.top - TIMELINE_WINDOW_VIEWPORT_MARGIN_PX;
        const viewportBottom =
          viewport.bottom + TIMELINE_WINDOW_VIEWPORT_MARGIN_PX;
        for (const [key, element] of wrapperByKeyRef.current) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom >= viewportTop && rect.top <= viewportBottom) {
            next.add(key);
          }
        }
      }
      return setsEqual(next, previous) ? previous : next;
    };

    const scrollElement = getScrollElement();
    if (scrollElement === null) {
      // A nested scroll root's DOM ref can attach after this child layout
      // effect. Resolve it once more before the first paint opportunity rather
      // than briefly mounting every nested rich row.
      const frame = requestAnimationFrame(() => {
        setRealizedKeys((previous) =>
          collectRealizedKeys(previous, getScrollElement()),
        );
      });
      return () => cancelAnimationFrame(frame);
    }
    setRealizedKeys((previous) => collectRealizedKeys(previous, scrollElement));
    // Geometry is re-read when the item identity changes. Scroll movement is
    // handled by IntersectionObserver.
  }, [alwaysMountedKeys, getScrollElement, keySignature, windowingEnabled]);

  useEffect(() => {
    if (!windowingEnabled || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const scrollElement = getScrollElement();
      const scrollRect = scrollElement?.getBoundingClientRect() ?? null;
      for (const entry of entries) {
        const key = keyByWrapperRef.current.get(entry.target);
        if (key === undefined || !(entry.target instanceof HTMLElement)) {
          continue;
        }
        const nextHeight = entry.target.getBoundingClientRect().height;
        const previousHeight = lastVisualHeightByKeyRef.current.get(key);
        lastVisualHeightByKeyRef.current.set(key, nextHeight);
        if (entry.target.dataset.timelineWindowedRealized === "true") {
          recordTimelineMeasurement(measurements, key, nextHeight);
        }
        // WebKit has no native scroll anchoring. Correct height changes that
        // happen wholly above the viewport so promoting a placeholder does not
        // move the row the user is reading.
        if (
          scrollElement !== null &&
          scrollRect !== null &&
          previousHeight !== undefined &&
          scrollElement.dataset.scrollbarScrolling !== "true" &&
          !supportsScrollAnchoring() &&
          entry.target.getBoundingClientRect().bottom <= scrollRect.top + 1
        ) {
          scrollElement.scrollTop += nextHeight - previousHeight;
        }
      }
    });
    resizeObserverRef.current = observer;
    for (const element of wrapperByKeyRef.current.values()) {
      observer.observe(element);
    }
    return () => {
      resizeObserverRef.current = null;
      observer.disconnect();
    };
  }, [getScrollElement, measurements, windowingEnabled]);

  useEffect(() => {
    if (!windowingEnabled || typeof IntersectionObserver === "undefined") {
      return;
    }
    const scrollElement = getScrollElement();
    if (scrollElement === null || scrollElement.clientHeight === 0) {
      return;
    }

    const intersectingKeys = new Set<string>();
    const pendingRealizeKeys = new Set<string>();
    let fastScrolling = false;
    let lastScrollTop = scrollElement.scrollTop;
    let lastScrollAt = performance.now();

    const applyWithScrollCompensation = (apply: () => void) => {
      const maxScrollTop = Math.max(
        0,
        scrollElement.scrollHeight - scrollElement.clientHeight,
      );
      const wasAtBottom = maxScrollTop - scrollElement.scrollTop <= 2;
      const anchor = wasAtBottom
        ? null
        : captureVisibleAnchor({
            itemKeys: itemKeysRef.current,
            scrollElement,
            wrapperByKey: wrapperByKeyRef.current,
          });
      flushSync(apply);
      restoreVisibleAnchor({ anchor, scrollElement, wasAtBottom });
    };

    const evictKeys = (keys: ReadonlySet<string>) => {
      if (keys.size === 0) {
        return;
      }
      setRealizedKeys((previous) => {
        let next: Set<string> | null = null;
        for (const key of keys) {
          const element = wrapperByKeyRef.current.get(key);
          if (
            element === undefined ||
            !previous.has(key) ||
            intersectingKeys.has(key) ||
            itemMustRemainMounted(
              element,
              alwaysMountedKeysRef.current.has(key),
              pinnedKeySetRef.current.has(key),
            )
          ) {
            continue;
          }
          next ??= new Set(previous);
          next.delete(key);
        }
        return next ?? previous;
      });
    };

    const pinInteractedKey = (key: string) => {
      const orderedPins = pinnedKeysRef.current;
      const existing = orderedPins.indexOf(key);
      if (existing >= 0) {
        orderedPins.splice(existing, 1);
      }
      orderedPins.push(key);
      pinnedKeySetRef.current.add(key);
      const releasedKeys = new Set<string>();
      while (orderedPins.length > TIMELINE_WINDOW_MAX_INTERACTION_PINS) {
        const released = orderedPins.shift();
        if (released !== undefined) {
          pinnedKeySetRef.current.delete(released);
          releasedKeys.add(released);
        }
      }
      evictKeys(releasedKeys);
    };

    const findOwnedKey = (target: EventTarget | null): string | null => {
      let element = target instanceof Element ? target : null;
      while (element !== null) {
        const key = keyByWrapperRef.current.get(element);
        if (key !== undefined) {
          return key;
        }
        if (element === scrollElement) {
          return null;
        }
        element = element.parentElement;
      }
      return null;
    };
    const handleInteraction = (event: Event) => {
      const key = findOwnedKey(event.target);
      if (key !== null) {
        pinInteractedKey(key);
      }
    };

    const applyPlaceholderHeight = (key: string, height: number) => {
      const nextHeight = Math.max(0, height);
      recordTimelineMeasurement(measurements, key, nextHeight);
      const wrapper = wrapperByKeyRef.current.get(key);
      if (wrapper !== undefined) {
        wrapper.style.height = `${nextHeight}px`;
        wrapper.style.minHeight = `${nextHeight}px`;
        lastVisualHeightByKeyRef.current.set(key, nextHeight);
      }
    };

    const tryCompensateAboveViewportDelta = (
      candidateIndex: number,
      delta: number,
    ): boolean => {
      if (Math.abs(delta) < 0.5) {
        return true;
      }
      if (delta < 0) {
        for (let index = 0; index < candidateIndex; index += 1) {
          const key = itemKeysRef.current[index];
          const wrapper =
            key === undefined ? undefined : wrapperByKeyRef.current.get(key);
          if (
            key !== undefined &&
            wrapper !== undefined &&
            wrapper.dataset.timelineWindowedRealized !== "true"
          ) {
            applyPlaceholderHeight(
              key,
              wrapper.getBoundingClientRect().height - delta,
            );
            return true;
          }
        }
        return false;
      }

      let remaining = delta;
      const takes: Array<{ key: string; nextHeight: number }> = [];
      for (
        let index = 0;
        index < candidateIndex && remaining > 0.5;
        index += 1
      ) {
        const key = itemKeysRef.current[index];
        const wrapper =
          key === undefined ? undefined : wrapperByKeyRef.current.get(key);
        if (
          key === undefined ||
          wrapper === undefined ||
          wrapper.dataset.timelineWindowedRealized === "true"
        ) {
          continue;
        }
        const available = wrapper.getBoundingClientRect().height;
        if (available <= 0) {
          continue;
        }
        const take = Math.min(available, remaining);
        takes.push({ key, nextHeight: available - take });
        remaining -= take;
      }
      if (remaining > 0.5) {
        return false;
      }
      for (const take of takes) {
        applyPlaceholderHeight(take.key, take.nextHeight);
      }
      return true;
    };

    let idlePassTimeout: number | null = null;
    const runIdlePass = () => {
      const pending = new Set(pendingRealizeKeys);
      for (const key of intersectingKeys) {
        const wrapper = wrapperByKeyRef.current.get(key);
        if (wrapper?.dataset.timelineWindowedRealized !== "true") {
          pending.add(key);
        }
      }
      if (pending.size === 0) {
        return;
      }
      pendingRealizeKeys.clear();
      fastScrolling = false;
      applyWithScrollCompensation(() => {
        setRealizedKeys((previous) => new Set([...previous, ...pending]));
      });
    };
    const scheduleIdlePass = () => {
      if (idlePassTimeout !== null) {
        window.clearTimeout(idlePassTimeout);
      }
      idlePassTimeout = window.setTimeout(() => {
        idlePassTimeout = null;
        if (scrollElement.dataset.scrollbarScrolling === "true") {
          scheduleIdlePass();
          return;
        }
        runIdlePass();
      }, TIMELINE_WINDOW_IDLE_DELAY_MS);
    };
    const handleScroll = () => {
      const now = performance.now();
      const elapsed = now - lastScrollAt;
      const distance = Math.abs(scrollElement.scrollTop - lastScrollTop);
      fastScrolling =
        elapsed <= 100 &&
        distance >= Math.max(200, scrollElement.clientHeight * 0.5);
      lastScrollTop = scrollElement.scrollTop;
      lastScrollAt = now;
      scheduleIdlePass();
    };

    const realizeAboveViewportDuringScroll = (keys: readonly string[]) => {
      const candidates = keys.flatMap((key) => {
        const wrapper = wrapperByKeyRef.current.get(key);
        const index = indexByKey.get(key);
        if (
          wrapper === undefined ||
          index === undefined ||
          wrapper.dataset.timelineWindowedRealized === "true"
        ) {
          return [];
        }
        return [
          {
            index,
            key,
            placeholderHeight: wrapper.getBoundingClientRect().height,
            wrapper,
          },
        ];
      });
      if (candidates.length === 0) {
        return;
      }

      flushSync(() => {
        setRealizedKeys(
          (previous) =>
            new Set([...previous, ...candidates.map(({ key }) => key)]),
        );
      });

      const failedKeys = new Set<string>();
      for (const candidate of candidates) {
        const measuredHeight = candidate.wrapper.getBoundingClientRect().height;
        const delta = measuredHeight - candidate.placeholderHeight;
        if (!tryCompensateAboveViewportDelta(candidate.index, delta)) {
          failedKeys.add(candidate.key);
          pendingRealizeKeys.add(candidate.key);
          continue;
        }
        recordTimelineMeasurement(measurements, candidate.key, measuredHeight);
        lastVisualHeightByKeyRef.current.set(candidate.key, measuredHeight);
      }
      if (failedKeys.size > 0) {
        flushSync(() => {
          setRealizedKeys((previous) => {
            const next = new Set(previous);
            for (const key of failedKeys) {
              next.delete(key);
            }
            return next;
          });
        });
        scheduleIdlePass();
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const enteringKeys: string[] = [];
        const enteringAboveViewportKeys: string[] = [];
        const exitingKeys = new Set<string>();
        const scrolling = scrollElement.dataset.scrollbarScrolling === "true";
        let viewportTop: number | null = null;
        for (const entry of entries) {
          const key = keyByWrapperRef.current.get(entry.target);
          if (key === undefined || !(entry.target instanceof HTMLElement)) {
            continue;
          }
          if (entry.isIntersecting) {
            intersectingKeys.add(key);
            pendingRealizeKeys.delete(key);
            if (entry.target.dataset.timelineWindowedRealized === "true") {
              continue;
            }
            // During a fling or synthetic jump, rendering every transient
            // viewport turns a cold traversal into an O(history) mount. Keep
            // placeholders moving and realize only the final intersecting set
            // after scroll idle. Ordinary reading-speed scrolls still realize
            // their overscan before it reaches the viewport.
            if (scrolling && fastScrolling) {
              continue;
            }
            if (scrolling) {
              const rootTop = entry.rootBounds?.top;
              viewportTop ??=
                rootTop !== undefined
                  ? rootTop + TIMELINE_WINDOW_VIEWPORT_MARGIN_PX
                  : scrollElement.getBoundingClientRect().top;
              if (entry.boundingClientRect.top < viewportTop) {
                enteringAboveViewportKeys.push(key);
                continue;
              }
            }
            enteringKeys.push(key);
            continue;
          }
          intersectingKeys.delete(key);
          pendingRealizeKeys.delete(key);
          const height = entry.boundingClientRect.height;
          if (
            height > 0 &&
            entry.target.dataset.timelineWindowedRealized === "true"
          ) {
            recordTimelineMeasurement(measurements, key, height);
          }
          if (
            entry.target instanceof HTMLElement &&
            entry.target.querySelector('button[aria-expanded="true"]') !== null
          ) {
            pinInteractedKey(key);
          }
          exitingKeys.add(key);
        }

        // Derealize exits immediately so a long or synthetic traversal cannot
        // accumulate every rich row before one idle eviction batch.
        evictKeys(exitingKeys);

        if (enteringAboveViewportKeys.length > 0) {
          realizeAboveViewportDuringScroll(enteringAboveViewportKeys);
        }
        if (enteringKeys.length > 0) {
          const realize = () =>
            setRealizedKeys(
              (previous) => new Set([...previous, ...enteringKeys]),
            );
          if (scrolling) {
            realize();
          } else {
            applyWithScrollCompensation(realize);
          }
        }
      },
      {
        root: scrollElement,
        rootMargin: `${TIMELINE_WINDOW_VIEWPORT_MARGIN_PX}px 0px`,
      },
    );
    intersectionObserverRef.current = observer;
    for (const element of wrapperByKeyRef.current.values()) {
      observer.observe(element);
    }
    scrollElement.addEventListener("click", handleInteraction, true);
    scrollElement.addEventListener("focusin", handleInteraction, true);
    scrollElement.addEventListener("scroll", handleScroll, {
      passive: true,
    });
    return () => {
      intersectionObserverRef.current = null;
      if (idlePassTimeout !== null) {
        window.clearTimeout(idlePassTimeout);
      }
      observer.disconnect();
      scrollElement.removeEventListener("click", handleInteraction, true);
      scrollElement.removeEventListener("focusin", handleInteraction, true);
      scrollElement.removeEventListener("scroll", handleScroll);
      intersectingKeys.clear();
      pendingRealizeKeys.clear();
    };
  }, [getScrollElement, indexByKey, measurements, windowingEnabled]);

  return (
    <>
      {itemKeys.map((key, index) => {
        const isRealized =
          !windowingEnabled ||
          realizedKeys.has(key) ||
          alwaysMountedKeys.has(key);
        return (
          <TimelineWindowedItemSlot
            key={key}
            estimatedHeight={
              measurements.get(key) ?? Math.max(1, estimateItemHeight(index))
            }
            index={index}
            isRealized={isRealized}
            itemRef={getWrapperRefCallback(key)}
            renderItem={renderItem}
            windowingEnabled={windowingEnabled}
          />
        );
      })}
    </>
  );
}
