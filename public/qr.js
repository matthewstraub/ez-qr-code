/*
 * qr.js — a small, dependency-free QR Code encoder.
 *
 * Implements ISO/IEC 18004 in byte mode: versions 1-40, error correction
 * levels L/M/Q/H, automatic version selection and automatic mask selection
 * via the standard penalty rules.
 *
 * Usage:
 *   const qr = QR.encode("https://example.com", "M");
 *   qr.size          // number of modules per side
 *   qr.get(x, y)     // true if the module at (x, y) is dark
 */
const QR = (function () {
  "use strict";

  // Error correction codewords per block, indexed [level][version].
  // Index 0 of each row is unused padding so versions are 1-based.
  const ECC_CODEWORDS_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };

  // Number of error correction blocks, indexed [level][version].
  const NUM_ECC_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };

  // The 2-bit identifier each level uses inside the format information.
  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  // ---- Galois field GF(256) arithmetic, primitive polynomial 0x11D ----

  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  // Coefficients of the generator polynomial of the given degree, highest first.
  function reedSolomonDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let j = 0; j < result.length; j++) {
        result[j] ^= gfMultiply(divisor[j], factor);
      }
    }
    return result;
  }

  // ---- Capacity maths ----

  // Total number of data + error correction modules available in a version,
  // i.e. everything that is not a function pattern.
  function rawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(version, ecl) {
    return (
      Math.floor(rawDataModules(version) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][version] * NUM_ECC_BLOCKS[ecl][version]
    );
  }

  // Byte mode uses an 8-bit character count for versions 1-9 and 16 bits above.
  function charCountBits(version) {
    return version <= 9 ? 8 : 16;
  }

  // ---- Bit stream helpers ----

  function appendBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  }

  function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  // ---- Encoding ----

  function toUtf8Bytes(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function chooseVersion(byteLength, ecl) {
    for (let version = 1; version <= 40; version++) {
      const capacityBits = dataCodewords(version, ecl) * 8;
      const neededBits = 4 + charCountBits(version) + byteLength * 8;
      if (neededBits <= capacityBits) return version;
    }
    return null;
  }

  function buildCodewords(bytes, version, ecl) {
    const capacityBits = dataCodewords(version, ecl) * 8;
    const bits = [];

    appendBits(bits, 0b0100, 4); // byte mode indicator
    appendBits(bits, bytes.length, charCountBits(version));
    for (let i = 0; i < bytes.length; i++) appendBits(bits, bytes[i], 8);

    // Terminator, then pad to a whole codeword, then alternating pad bytes.
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
      appendBits(bits, pad, 8);
    }

    const codewords = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) {
      codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
    }
    return codewords;
  }

  // Split data into blocks, append error correction to each, then interleave.
  function addEccAndInterleave(data, version, ecl) {
    const numBlocks = NUM_ECC_BLOCKS[ecl][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
    const rawCodewords = Math.floor(rawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const divisor = reedSolomonDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      const dat = Array.from(data.slice(k, k + len));
      k += len;
      const ecc = reedSolomonRemainder(dat, divisor);
      // Short blocks get a placeholder so every block has the same length;
      // the interleaver skips it below.
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(Array.from(ecc)));
    }

    const result = new Uint8Array(rawCodewords);
    let n = 0;
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
          result[n++] = blocks[j][i];
        }
      }
    }
    return result;
  }

  // ---- Matrix construction ----

  function alignmentPatternPositions(version) {
    if (version === 1) return [];
    const numAlign = Math.floor(version / 7) + 2;
    const step =
      version === 32
        ? 26
        : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const size = version * 4 + 17;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  function createMatrix(version, ecl, codewords) {
    const size = version * 4 + 17;
    const modules = [];
    const isFunction = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }

    function setFunctionModule(x, y, dark) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }

    function drawFinderPattern(x, y) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
            setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
          }
        }
      }
    }

    function drawAlignmentPattern(x, y) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(
            x + dx,
            y + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1
          );
        }
      }
    }

    function drawFormatBits(mask) {
      const data = (FORMAT_BITS[ecl] << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;

      for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bits, i));
      setFunctionModule(8, 7, getBit(bits, 6));
      setFunctionModule(8, 8, getBit(bits, 7));
      setFunctionModule(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bits, i));

      for (let i = 0; i < 8; i++) {
        setFunctionModule(size - 1 - i, 8, getBit(bits, i));
      }
      for (let i = 8; i < 15; i++) {
        setFunctionModule(8, size - 15 + i, getBit(bits, i));
      }
      setFunctionModule(8, size - 8, true); // the always-dark module
    }

    function drawVersionBits() {
      if (version < 7) return;
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunctionModule(a, b, bit);
        setFunctionModule(b, a, bit);
      }
    }

    // Timing patterns.
    for (let i = 0; i < size; i++) {
      setFunctionModule(6, i, i % 2 === 0);
      setFunctionModule(i, 6, i % 2 === 0);
    }

    drawFinderPattern(3, 3);
    drawFinderPattern(size - 4, 3);
    drawFinderPattern(3, size - 4);

    const alignPos = alignmentPatternPositions(version);
    const numAlign = alignPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        // The three corners already hold finder patterns.
        const isCorner =
          (i === 0 && j === 0) ||
          (i === 0 && j === numAlign - 1) ||
          (i === numAlign - 1 && j === 0);
        if (!isCorner) drawAlignmentPattern(alignPos[i], alignPos[j]);
      }
    }

    drawFormatBits(0); // placeholder, rewritten once the mask is chosen
    drawVersionBits();

    // Lay the codewords out in the zig-zag pattern, skipping function modules.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < codewords.length * 8) {
            modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    return { size, modules, isFunction, setFunctionModule, drawFormatBits };
  }

  // ---- Masking ----

  const MASK_FUNCTIONS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(matrix, mask) {
    const { size, modules, isFunction } = matrix;
    const fn = MASK_FUNCTIONS[mask];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && fn(x, y)) {
          modules[y][x] = !modules[y][x];
        }
      }
    }
  }

  // The four penalty rules from the spec; lower is better.
  function penaltyScore(matrix) {
    const { size, modules } = matrix;
    let result = 0;

    // Rule 1: runs of five or more modules of the same colour.
    for (let y = 0; y < size; y++) {
      let runColor = modules[y][0];
      let runLength = 1;
      for (let x = 1; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) result += 3 + (runLength - 5);
          runColor = modules[y][x];
          runLength = 1;
        }
      }
      if (runLength >= 5) result += 3 + (runLength - 5);
    }
    for (let x = 0; x < size; x++) {
      let runColor = modules[0][x];
      let runLength = 1;
      for (let y = 1; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) result += 3 + (runLength - 5);
          runColor = modules[y][x];
          runLength = 1;
        }
      }
      if (runLength >= 5) result += 3 + (runLength - 5);
    }

    // Rule 2: 2x2 blocks of a single colour.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (
          c === modules[y][x + 1] &&
          c === modules[y + 1][x] &&
          c === modules[y + 1][x + 1]
        ) {
          result += 3;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
    const PATTERN = [true, false, true, true, true, false, true];
    function hasFinderLike(get, center) {
      for (let i = 0; i < 7; i++) {
        if (get(center + i) !== PATTERN[i]) return false;
      }
      let before = true;
      let after = true;
      for (let i = 1; i <= 4; i++) {
        if (get(center - i) !== false) before = false;
        if (get(center + 6 + i) !== false) after = false;
      }
      return before || after;
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x <= size - 7; x++) {
        const get = (i) => (i < 0 || i >= size ? false : modules[y][i]);
        if (hasFinderLike(get, x)) result += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y <= size - 7; y++) {
        const get = (i) => (i < 0 || i >= size ? false : modules[i][x]);
        if (hasFinderLike(get, y)) result += 40;
      }
    }

    // Rule 4: how far the ratio of dark modules strays from 50%.
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;

    return result;
  }

  // ---- Public API ----

  /**
   * Encode text as a QR Code.
   * @param {string} text - the content to encode
   * @param {"L"|"M"|"Q"|"H"} ecl - error correction level
   * @returns {{size:number, version:number, ecl:string, mask:number, get:(x:number,y:number)=>boolean}}
   */
  function encode(text, ecl) {
    if (typeof text !== "string") throw new TypeError("text must be a string");
    if (!ECC_CODEWORDS_PER_BLOCK[ecl]) throw new RangeError("bad ecl: " + ecl);

    const bytes = toUtf8Bytes(text);
    const version = chooseVersion(bytes.length, ecl);
    if (version === null) {
      throw new RangeError(
        "Too much data: " +
          bytes.length +
          " bytes exceeds the capacity of a level " +
          ecl +
          " QR Code"
      );
    }

    const codewords = addEccAndInterleave(
      buildCodewords(bytes, version, ecl),
      version,
      ecl
    );
    const matrix = createMatrix(version, ecl, codewords);

    // Try every mask and keep the one with the lowest penalty.
    let bestMask = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(matrix, mask);
      matrix.drawFormatBits(mask);
      const penalty = penaltyScore(matrix);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
      applyMask(matrix, mask); // undo (XOR is its own inverse)
    }
    applyMask(matrix, bestMask);
    matrix.drawFormatBits(bestMask);

    return {
      size: matrix.size,
      version,
      ecl,
      mask: bestMask,
      get(x, y) {
        if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return false;
        return matrix.modules[y][x];
      },
    };
  }

  /** Largest number of UTF-8 bytes that fits at the given level. */
  function maxBytes(ecl) {
    return dataCodewords(40, ecl) - 3; // minus mode + 16-bit count overhead
  }

  return {
    encode,
    maxBytes,
    /**
     * Spec tables and geometry shared with the decoder in qr-decode.js, so
     * there is only ever one copy of them to get wrong.
     */
    spec: {
      eccCodewordsPerBlock: ECC_CODEWORDS_PER_BLOCK,
      numEccBlocks: NUM_ECC_BLOCKS,
      formatBits: FORMAT_BITS,
      rawDataModules,
      dataCodewords,
      alignmentPatternPositions,
    },
  };
})();
