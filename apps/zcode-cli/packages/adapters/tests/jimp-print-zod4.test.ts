import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as esmJimp from "jimp";
import { SANS_16_BLACK } from "jimp/fonts";

const commonJsJimp = createRequire(import.meta.url)("jimp") as typeof esmJimp;

describe.each([
  { name: "ESM", runtime: esmJimp },
  { name: "CommonJS", runtime: commonJsJimp },
])("Jimp print callback compatibility ($name)", ({ runtime }) => {
  const { Jimp, JimpMime, loadFont, measureText } = runtime;
  it("draws real glyphs and preserves the image-bound completion callback", async () => {
    const font = await loadFont(SANS_16_BLACK);
    const image = new Jimp({ width: 128, height: 48, color: 0xffffffff });
    const original = Buffer.from(image.bitmap.data);
    const completed: { x: number; y: number }[] = [];

    const returned = image.print({
      font,
      x: 3,
      y: 5,
      text: "UWork",
      maxWidth: 120,
      cb: function (this: unknown, point) {
        expect(this).toBe(image);
        completed.push(point);
      },
    });

    expect(returned).toBe(image);
    expect(completed).toEqual([
      { x: 3 + measureText(font, "UWork"), y: 5 + font.common.lineHeight },
    ]);
    expect(Buffer.from(image.bitmap.data).equals(original)).toBe(false);
    const decoded = await Jimp.read(await image.getBuffer(JimpMime.png));
    expect(decoded.bitmap.width).toBe(128);
    expect(decoded.bitmap.height).toBe(48);
    expect(decoded.bitmap.data).toEqual(image.bitmap.data);
  });

  it("rejects a non-function completion callback before drawing", async () => {
    const font = await loadFont(SANS_16_BLACK);
    const image = new Jimp({ width: 64, height: 32, color: 0xffffffff });
    const original = Buffer.from(image.bitmap.data);

    expect(() =>
      image.print({ font, x: 0, y: 0, text: "U", cb: "not-callable" as never }),
    ).toThrow();
    expect(Buffer.from(image.bitmap.data).equals(original)).toBe(true);
  });

  it("validates completion coordinates before invoking the supplied callback", async () => {
    const font = await loadFont(SANS_16_BLACK);
    const invalidFont = { ...font, common: { ...font.common, lineHeight: Number.NaN } };
    const image = new Jimp({ width: 64, height: 32, color: 0xffffffff });
    let called = false;

    expect(() =>
      image.print({
        font: invalidFont,
        x: 0,
        y: 0,
        text: "U",
        cb: () => {
          called = true;
        },
      }),
    ).toThrow();
    expect(called).toBe(false);
  });
});
