// @vitest-environment jsdom

import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelInputModalityOptions } from "@/settings/model-provider-section/ProviderModelModalityOptions.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id.split(".").at(-1)?.toUpperCase() ?? id,
    },
  }),
}));

afterEach(cleanup);

describe("ProviderModelInputModalityOptions", () => {
  it("展示五类输入能力，音频与 PDF 都可独立切换", () => {
    function Harness() {
      const [value, setValue] = useState({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: true,
        supportsPdf: false,
      });
      return createElement(ProviderModelInputModalityOptions, { value, onChange: setValue });
    }

    const { container } = render(createElement(Harness));

    expect(container.querySelectorAll("[data-model-input-modality]")).toHaveLength(5);
    const audio = screen.getByRole("button", { name: "AUDIO" });
    expect(audio.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(audio);
    expect(audio.getAttribute("aria-pressed")).toBe("false");
    const pdf = screen.getByRole("button", { name: "PDF" });
    expect(pdf.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pdf);

    expect(pdf.getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "TEXT" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("非聊天型号保留未选中的 Text，修改其他输入能力不伪造文本支持", () => {
    const onChange = vi.fn();
    render(
      createElement(ProviderModelInputModalityOptions, {
        value: {
          supportsText: false,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: true,
          supportsPdf: false,
        },
        onChange,
      }),
    );
    const text = screen.getByRole("button", { name: "TEXT" });
    expect(text.getAttribute("aria-pressed")).toBe("false");
    expect((text as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "IMAGE" }));
    expect(onChange).toHaveBeenCalledWith({
      supportsText: false,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: true,
      supportsPdf: false,
    });
  });
});
