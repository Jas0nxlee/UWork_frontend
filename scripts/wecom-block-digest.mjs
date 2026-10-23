import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const BLOCK_SIZE = 2 * 1024 * 1024;
export const MAX_FILE_SIZE = 20 * 1024 ** 3;

export async function* fileBlocks(path) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE)
      throw new Error("微盘安装包大小必须在 1 字节至 20 GiB 之间");
    for (let position = 0; position < size; position += BLOCK_SIZE) {
      const block = Buffer.allocUnsafe(Math.min(BLOCK_SIZE, size - position));
      let offset = 0;
      while (offset < block.length) {
        const { bytesRead } = await handle.read(
          block,
          offset,
          block.length - offset,
          position + offset,
        );
        if (!bytesRead) throw new Error("读取安装包时文件发生变化");
        offset += bytesRead;
      }
      yield { block, last: position + block.length === size };
    }
  } finally {
    await handle.close();
  }
}

const rotate = (value, bits) => (value << bits) | (value >>> (32 - bits));

// 官方合同需要未执行 SHA1_Final 的内部 state，Hash.copy().digest() 会加 padding，不能替代。
// 这里只处理完整 64 字节组；末块的标准 SHA-1 交给 Node crypto 计算。
function updateState(state, block) {
  const words = new Int32Array(80);
  for (let offset = 0; offset < block.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = block.readInt32BE(offset + index * 4);
    for (let index = 16; index < 80; index++)
      words[index] = rotate(
        words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
        1,
      );
    let [a, b, c, d, e] = state;
    for (let index = 0; index < 80; index++) {
      let f, k;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotate(a, 5) + f + e + k + words[index]) | 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0;
  }
}

export async function blockDigests(path) {
  const state = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const sha1 = createHash("sha1");
  const result = [];
  for await (const { block, last } of fileBlocks(path)) {
    sha1.update(block);
    if (last) result.push(sha1.digest("hex"));
    else {
      updateState(state, block);
      // 与企业微信官方 C++ 示例的 SHA_CTX 内存字节序一致：五个 uint32 按小端序输出。
      const bytes = Buffer.allocUnsafe(20);
      state.forEach((value, index) => bytes.writeInt32LE(value, index * 4));
      result.push(bytes.toString("hex"));
    }
  }
  return result;
}
