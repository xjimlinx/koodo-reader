import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Book from "../../models/Book";

const { config, getIframeDoc } = vi.hoisted(() => ({
  config: new Map<string, string>(),
  getIframeDoc: vi.fn(),
}));

vi.mock("../../assets/lib/kookit-extra-browser.min", () => ({
  ConfigService: {
    getReaderConfig: (key: string) => config.get(key),
    setObjectConfig: vi.fn(),
  },
}));
vi.mock("react-device-detect", () => ({ isElectron: false }));
vi.mock("./docUtil", () => ({
  getIframeDoc,
  getIframeWin: () => ({ focus: vi.fn() }),
}));
vi.mock("../common", () => ({
  handleExitFullScreen: vi.fn(),
  handleFullScreen: vi.fn(),
  isReadingAidMode: () => false,
  sleep: (delay: number) =>
    new Promise((resolve) => setTimeout(resolve, delay)),
}));
vi.mock("hammerjs", () => ({ default: vi.fn() }));
vi.mock("./ttsUtil", () => ({ default: {} }));

class EventSurface {
  private listeners = new Map<string, Array<(event: object) => unknown>>();

  addEventListener(type: string, listener: (event: object) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  async emit(type: string, event: object = {}) {
    await Promise.all(
      (this.listeners.get(type) || []).map((listener) => listener(event))
    );
  }
}

const nextPageKey = () => ({
  target: { tagName: "BODY" },
  keyCode: 39,
  repeat: true,
  preventDefault: vi.fn(),
});
const wheelDown = () => ({
  deltaX: 0,
  deltaY: 100,
  ctrlKey: false,
  preventDefault: vi.fn(),
});

let doc: EventSurface;
let readerWindow: EventSurface;
let rendition: {
  next: ReturnType<typeof vi.fn>;
  prev: ReturnType<typeof vi.fn>;
  getPosition: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};
let rendered: () => void;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  config.clear();
  doc = new EventSurface();
  readerWindow = new EventSurface();
  vi.stubGlobal("window", readerWindow);
  getIframeDoc.mockReturnValue([doc]);
  rendition = {
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    getPosition: vi.fn().mockReturnValue({}),
    on: vi.fn((_event: string, callback: () => void) => {
      rendered = callback;
    }),
  };
  const { bindHtmlEvent, htmlMouseEvent } = await import("./mouseEvent");
  const book = { key: "test-book", format: "EPUB" } as Book;
  bindHtmlEvent(rendition, doc, book, "double", vi.fn(), vi.fn());
  htmlMouseEvent(rendition, book, "double", vi.fn(), vi.fn());
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("page turning interval", () => {
  it.each([
    ["none", 100],
    ["sliding", 200],
    ["mimical", 200],
  ])("preserves the default delay for %s", async (animation, delay) => {
    config.set("animation", animation);
    await doc.emit("keydown", nextPageKey());
    await vi.advanceTimersByTimeAsync(Number(delay) - 1);
    await doc.emit("keydown", nextPageKey());
    expect(rendition.next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await doc.emit("keydown", nextPageKey());
    expect(rendition.next).toHaveBeenCalledTimes(2);
  });

  it.each([50, 100, 200, 300, 500, 1000])(
    "honors a %i ms interval for repeated keys and wheels across render events",
    async (interval) => {
      config.set("animation", "mimical");
      config.set("pageTurnInterval", String(interval));
      await doc.emit("keydown", nextPageKey());
      await readerWindow.emit("page-flipend");
      rendered();
      await vi.advanceTimersByTimeAsync(interval - 1);
      await readerWindow.emit("keydown", nextPageKey());
      await doc.emit("wheel", wheelDown());
      expect(rendition.next).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await doc.emit("wheel", wheelDown());
      expect(rendition.next).toHaveBeenCalledTimes(2);
    }
  );

  it("reads interval changes without rebinding or reloading", async () => {
    config.set("pageTurnInterval", "1000");
    await doc.emit("keydown", nextPageKey());
    await vi.advanceTimersByTimeAsync(1000);
    config.set("pageTurnInterval", "50");
    await readerWindow.emit("keydown", nextPageKey());
    await vi.advanceTimersByTimeAsync(50);
    await doc.emit("keydown", nextPageKey());
    expect(rendition.next).toHaveBeenCalledTimes(3);
  });

  it.each(["", " ", "invalid", "0", "-1", "49", "2001", "Infinity", "50.5"])(
    "falls back to the default for invalid interval %j",
    async (interval) => {
      config.set("pageTurnInterval", interval);
      await doc.emit("keydown", nextPageKey());
      await vi.advanceTimersByTimeAsync(99);
      await doc.emit("keydown", nextPageKey());
      expect(rendition.next).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await doc.emit("keydown", nextPageKey());
      expect(rendition.next).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps early animation unlocking for the default setting", async () => {
    config.set("animation", "mimical");
    await doc.emit("keydown", nextPageKey());
    await vi.advanceTimersByTimeAsync(50);
    await readerWindow.emit("page-flipend");
    await doc.emit("keydown", nextPageKey());
    expect(rendition.next).toHaveBeenCalledTimes(2);
    // The first turn's old timeout must not unlock the second turn.
    await vi.advanceTimersByTimeAsync(150);
    await doc.emit("keydown", nextPageKey());
    expect(rendition.next).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    await doc.emit("keydown", nextPageKey());
    expect(rendition.next).toHaveBeenCalledTimes(3);
  });
});
