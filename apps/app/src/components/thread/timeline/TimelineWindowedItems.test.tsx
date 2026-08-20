// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TimelineWindowedItems,
  type TimelineWindowedItemRenderState,
} from "./TimelineWindowedItems.js";

interface ObserverHarness {
  emit: (
    target: Element,
    options: { height?: number; isIntersecting: boolean; top?: number },
  ) => void;
  observed: Set<Element>;
}

interface ResizeHarness {
  emit: (target: Element, height: number) => void;
}

const ITEM_KEYS = Array.from({ length: 30 }, (_, index) => `row-${index}`);

let intersectionHarnesses: ObserverHarness[] = [];
let resizeHarnesses: ResizeHarness[] = [];
let scrollElement: HTMLDivElement;

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 320,
    top,
    width: 320,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function installObserverStubs(): void {
  class IntersectionObserverStub {
    readonly root: Element | Document | null = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    private readonly observed = new Set<Element>();

    constructor(private readonly callback: IntersectionObserverCallback) {
      intersectionHarnesses.push({
        emit: (target, { height = 32, isIntersecting, top = 2_000 }) => {
          this.callback(
            [
              {
                boundingClientRect: rect(top, height),
                intersectionRatio: isIntersecting ? 1 : 0,
                intersectionRect: rect(top, isIntersecting ? height : 0),
                isIntersecting,
                rootBounds: rect(0, 500),
                target,
                time: performance.now(),
              },
            ],
            this as unknown as IntersectionObserver,
          );
        },
        observed: this.observed,
      });
    }

    disconnect(): void {
      this.observed.clear();
    }

    observe(target: Element): void {
      this.observed.add(target);
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    unobserve(target: Element): void {
      this.observed.delete(target);
    }
  }

  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {
      resizeHarnesses.push({
        emit: (target, height) => {
          this.callback(
            [
              {
                borderBoxSize: [{ blockSize: height, inlineSize: 320 }],
                contentBoxSize: [{ blockSize: height, inlineSize: 320 }],
                contentRect: rect(-100, height),
                devicePixelContentBoxSize: [],
                target,
              },
            ],
            this as unknown as ResizeObserver,
          );
        },
      });
    }
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  }

  vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
}

function renderWindowedItems(options?: {
  alwaysExpandedIndex?: number;
  clientHeight?: number;
  enabled?: boolean;
  measurements?: Map<string, number>;
}) {
  const measurements = options?.measurements ?? new Map<string, number>();
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: options?.clientHeight ?? 500,
  });
  return {
    ...render(
      <TimelineWindowedItems
        enabled={options?.enabled ?? true}
        estimateItemHeight={() => 32}
        getScrollElement={() => scrollElement}
        itemKeys={ITEM_KEYS}
        measurements={measurements}
        renderItem={(index: number, state: TimelineWindowedItemRenderState) => (
          <div
            key={ITEM_KEYS[index]}
            ref={state.itemRef}
            data-index={index}
            data-testid={`wrapper-${index}`}
            data-timeline-windowed-realized={String(state.isRealized)}
            data-windowed={String(state.isRealized)}
            style={state.placeholderStyle}
          >
            {state.isRealized ? (
              <div data-testid={`content-${index}`}>
                row {index}
                {options?.alwaysExpandedIndex === index ? (
                  <button aria-expanded="true">Expanded detail</button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      />,
      { container: scrollElement },
    ),
    measurements,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  intersectionHarnesses = [];
  resizeHarnesses = [];
  scrollElement = document.createElement("div");
  document.body.append(scrollElement);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === scrollElement) {
        return rect(0, 500);
      }
      const index = Number(this.dataset.index);
      return Number.isFinite(index) && index < 4
        ? rect(index * 40, 32)
        : rect(2_000, 32);
    },
  );
  installObserverStubs();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TimelineWindowedItems", () => {
  it("keeps the control path fully mounted when the experiment is off", () => {
    renderWindowedItems({ enabled: false });

    expect(screen.getAllByTestId(/^content-/)).toHaveLength(30);
    expect(screen.getByTestId("wrapper-20").style.height).toBe("");
  });

  it("keeps stable wrappers while mounting only rows near the scrollport", () => {
    renderWindowedItems();

    expect(screen.getAllByTestId(/^wrapper-/)).toHaveLength(30);
    expect(screen.getByTestId("content-0")).toBeTruthy();
    expect(screen.queryByTestId("content-20")).toBeNull();
    const placeholder = screen.getByTestId("wrapper-20");
    expect(placeholder.style.height).toBe("32px");
    expect(placeholder.style.minHeight).toBe("32px");
    expect(placeholder.style.overflow).toBe("hidden");
  });

  it("promotes an entering row and reuses its measured height after eviction", async () => {
    const { measurements } = renderWindowedItems();
    const target = screen.getByTestId("wrapper-20");
    const observer = intersectionHarnesses[0];
    expect(observer?.observed.has(target)).toBe(true);

    await act(async () => {
      observer?.emit(target, { isIntersecting: true });
    });
    expect(screen.getByTestId("content-20")).toBeTruthy();

    await act(async () => {
      observer?.emit(target, { height: 64, isIntersecting: false });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId("content-20")).toBeNull();
    expect(screen.getByTestId("wrapper-20").style.height).toBe("64px");
    expect(measurements.get("row-20")).toBe(64);
  });

  it("evicts exiting rows during an active gesture instead of accumulating them", async () => {
    renderWindowedItems();
    const target = screen.getByTestId("wrapper-20");
    const observer = intersectionHarnesses[0];

    await act(async () => {
      observer?.emit(target, { isIntersecting: true });
    });
    scrollElement.dataset.scrollbarScrolling = "true";
    await act(async () => {
      observer?.emit(target, { isIntersecting: false });
    });

    expect(screen.queryByTestId("content-20")).toBeNull();
  });

  it("defers transient rows during a fast traversal and realizes the idle viewport", async () => {
    renderWindowedItems();
    const target = screen.getByTestId("wrapper-20");
    scrollElement.dataset.scrollbarScrolling = "true";
    scrollElement.scrollTop = 1_000;
    fireEvent.scroll(scrollElement);

    await act(async () => {
      intersectionHarnesses[0]?.emit(target, { isIntersecting: true });
    });
    expect(screen.queryByTestId("content-20")).toBeNull();

    scrollElement.removeAttribute("data-scrollbar-scrolling");
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId("content-20")).toBeTruthy();
  });

  it("balances above-viewport realization without writing scrollTop mid-gesture", async () => {
    let scrollTop = 17;
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    renderWindowedItems();
    const target = screen.getByTestId("wrapper-20");
    target.getBoundingClientRect = () =>
      rect(-100, target.dataset.timelineWindowedRealized === "true" ? 100 : 32);
    scrollElement.dataset.scrollbarScrolling = "true";

    await act(async () => {
      intersectionHarnesses[0]?.emit(target, {
        height: 32,
        isIntersecting: true,
        top: -100,
      });
    });

    expect(screen.getByTestId("content-20")).toBeTruthy();
    expect(scrollTop).toBe(17);
    const donorHeights = [4, 5, 6].map(
      (index) => screen.getByTestId(`wrapper-${index}`).style.height,
    );
    expect(donorHeights).toEqual(["0px", "0px", "28px"]);
  });

  it("does not compensate late above-viewport growth until scrolling is idle", async () => {
    let scrollTop = 17;
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      value: 5_000,
    });
    Object.defineProperty(scrollElement, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    renderWindowedItems();
    const target = screen.getByTestId("wrapper-20");
    target.getBoundingClientRect = () => rect(-100, 64);
    await act(async () => {
      intersectionHarnesses[0]?.emit(target, { isIntersecting: true });
    });

    scrollElement.dataset.scrollbarScrolling = "true";
    act(() => resizeHarnesses[0]?.emit(target, 64));
    expect(scrollTop).toBe(17);

    scrollElement.removeAttribute("data-scrollbar-scrolling");
    target.getBoundingClientRect = () => rect(-100, 96);
    act(() => resizeHarnesses[0]?.emit(target, 96));
    expect(scrollTop).toBe(49);
  });

  it("retains an expanded row shell after it leaves the window", async () => {
    renderWindowedItems({ alwaysExpandedIndex: 20 });
    const target = screen.getByTestId("wrapper-20");
    const observer = intersectionHarnesses[0];

    await act(async () => {
      observer?.emit(target, { isIntersecting: true });
    });
    expect(
      screen.getByRole("button", { name: "Expanded detail" }),
    ).toBeTruthy();

    await act(async () => {
      observer?.emit(target, { isIntersecting: false });
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(
      screen.getByRole("button", { name: "Expanded detail" }),
    ).toBeTruthy();
  });

  it("bounds interaction-retained rows in a long-lived timeline", async () => {
    renderWindowedItems();
    const observer = intersectionHarnesses[0];

    for (let index = 4; index < 29; index += 1) {
      const target = screen.getByTestId(`wrapper-${index}`);
      await act(async () => {
        observer?.emit(target, { isIntersecting: true });
      });
      fireEvent.click(screen.getByTestId(`content-${index}`));
      await act(async () => {
        observer?.emit(target, { isIntersecting: false });
      });
    }

    expect(screen.queryByTestId("content-4")).toBeNull();
    expect(screen.getByTestId("content-28")).toBeTruthy();
  });

  it("keeps observers stable while existing rows stream new content", () => {
    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const measurements = new Map<string, number>();
    const getScrollElement = () => scrollElement;
    const estimateItemHeight = () => 32;
    const renderList = (version: string) => (
      <TimelineWindowedItems
        enabled
        estimateItemHeight={estimateItemHeight}
        getScrollElement={getScrollElement}
        itemKeys={[...ITEM_KEYS]}
        measurements={measurements}
        renderItem={(index, state) => (
          <div
            key={ITEM_KEYS[index]}
            ref={state.itemRef}
            data-index={index}
            data-testid={`stream-wrapper-${index}`}
            data-timeline-windowed-realized={String(state.isRealized)}
            style={state.placeholderStyle}
          >
            {state.isRealized ? `${version}-${index}` : null}
          </div>
        )}
      />
    );
    const view = render(renderList("first"), { container: scrollElement });

    expect(intersectionHarnesses).toHaveLength(1);
    expect(screen.getByTestId("stream-wrapper-0").textContent).toBe("first-0");
    view.rerender(renderList("second"));

    expect(intersectionHarnesses).toHaveLength(1);
    expect(screen.getByTestId("stream-wrapper-0").textContent).toBe("second-0");
  });

  it("renders everything when its scrollport has no usable geometry", () => {
    renderWindowedItems({ clientHeight: 0 });

    expect(screen.getAllByTestId(/^content-/)).toHaveLength(30);
  });
});
