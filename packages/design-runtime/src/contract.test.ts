import { describe, expect, it } from "vitest";
import { DESIGN_PAGE_LIMITS, DESIGN_RUNTIME_VERSION } from "./contract.js";
import {
  parseDesignPageInfo,
  parseDesignPageSignals,
  parseDesignRuntimeEvents,
  parsePageElementSnapshot,
} from "./hostScripts.js";
import { locateSourceElement, rewriteSourceElement } from "./sourceEdit.js";

// design-runtime 的对外承诺只有两条：页面能伪造的任何输入都在宿主侧截断/丢弃；
// 源码写回只改路径、id、class 都对得上的那个元素，对不上就什么都不写。

describe("design runtime contract", () => {
  it("截断超出单条消息上限的页面事件，非数组一律丢弃", () => {
    const forged = Array.from({ length: DESIGN_PAGE_LIMITS.eventsPerMessage + 8 }, () => ({
      type: "stage-changed",
      stageBackdrop: true,
    }));
    expect(parseDesignRuntimeEvents(forged)).toHaveLength(DESIGN_PAGE_LIMITS.eventsPerMessage);
    expect(parseDesignRuntimeEvents({ events: forged })).toEqual([]);
  });

  it("元素快照按上限截断长文本，缺 tagName 返回 null", () => {
    const snapshot = parsePageElementSnapshot({
      pageUrl: "file:///tmp/design.html",
      pageTitle: "T",
      tagName: "H1",
      text: "x".repeat(DESIGN_PAGE_LIMITS.longText + 64),
      capturedAt: 1,
    });
    expect(snapshot?.text).toHaveLength(DESIGN_PAGE_LIMITS.longText);
    expect(snapshot?.capturedAt).toBe(1);
    expect(parsePageElementSnapshot({ text: "no tag" })).toBeNull();
  });

  it("页面信号只留 -- 变量，并按条数上限截断", () => {
    const signals = parseDesignPageSignals({
      isDesignDocument: true,
      cssVariableNames: ["--a", "color", "--b"],
      variants: ["dark"],
      slideCount: 3,
    });
    expect(signals?.cssVariableNames).toEqual(["--a", "--b"]);
    expect(signals?.isDesignDocument).toBe(true);
    const many = parseDesignPageSignals({
      cssVariableNames: Array.from({ length: 40 }, (_, i) => `--v${i}`),
    });
    expect(many?.cssVariableNames).toHaveLength(DESIGN_PAGE_LIMITS.cssVariables);
  });

  it("页面信息缺 variants / cssVariables 时返回 null", () => {
    expect(parseDesignPageInfo({ pageUrl: "file:///a.html" })).toBeNull();
    expect(
      parseDesignPageInfo({
        variants: [],
        cssVariables: [],
        pageUrl: "file:///a.html",
        slideCount: 1,
      }),
    ).toMatchObject({ pageUrl: "file:///a.html", slideCount: 1, currentSlide: 0 });
  });

  it("源码写回只改路径对得上的元素，id / class 不符时不写", () => {
    const source =
      '<html><head></head><body><section><h1 id="t" class="title">Hi</h1></section></body></html>';
    const path = {
      steps: [
        { tag: "body", index: 1, siblings: 2 },
        { tag: "section", index: 0, siblings: 1 },
        { tag: "h1", index: 0, siblings: 1 },
      ],
      id: "t",
      className: "title",
    };
    const location = locateSourceElement(source, path);
    expect(location).not.toBeNull();
    expect(rewriteSourceElement(source, location!, { text: "Hello" })).toContain(">Hello</h1>");
    expect(locateSourceElement(source, { ...path, id: "other" })).toBeNull();
  });

  it("运行时版本是页面复用的标识", () => {
    expect(DESIGN_RUNTIME_VERSION).toMatch(/^\d+$/u);
  });
});
