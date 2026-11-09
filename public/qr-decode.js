/*
 * qr-decode.js — a dependency-free QR Code reader.
 *
 * Takes the pixels of a photo or camera frame and returns the text encoded in
 * any QR code it can find. The pipeline is the classic one:
 *
 *   1. grayscale, then an adaptive threshold that tolerates uneven lighting
 *   2. locate the three finder patterns (the big squares in the corners)
 *   3. work out the grid size and correct for the angle the camera was held at
 *   4. sample each module, read the format bits, undo the mask
 *   5. de-interleave the blocks and repair damage with Reed-Solomon
 *   6. parse the bitstream into text
 *
 * Spec tables are shared with the encoder via QR.spec, so qr.js must be loaded
 * first.
 *
 * Usage:
 *   const result = QRDecode.decode(imageData);
 *   result && result.text
 */
const QRDecode = (function () {
  "use strict";

  const spec = QR.spec;

  // ------------------------------ GF(256) ------------------------------
  // Same field as the encoder: primitive polynomial 0x11D, generator 2.

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  const gfDiv = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]);

  /** Evaluate a polynomial given highest-degree-first coefficients. */
  function polyEvalDescending(coeffs, x) {
    let y = 0;
    for (let i = 0; i < coeffs.length; i++) {
      y = gfMul(y, x) ^ coeffs[i];
    }
    return y;
  }

  // ------------------------------ Reed-Solomon ------------------------------

  /**
   * Repair a received block in place. `block` holds data codewords followed by
   * `eccLength` error correction codewords. Returns the number of errors
   * corrected, or -1 if the block is beyond repair.
   *
   * The encoder builds its generator from roots a^0 .. a^(n-1), so syndromes
   * are evaluated at those same powers.
   */
  function reedSolomonDecode(block, eccLength) {
    // --- syndromes ---
    const syndromes = new Array(eccLength).fill(0);
    let hasError = false;
    for (let i = 0; i < eccLength; i++) {
      syndromes[i] = polyEvalDescending(block, EXP[i]);
      if (syndromes[i] !== 0) hasError = true;
    }
    if (!hasError) return 0;

    // --- Berlekamp-Massey: find the error locator polynomial ---
    // Coefficients are ascending here (index i is the x^i term).
    let lambda = [1];
    let prev = [1];
    let L = 0;
    let m = 1;
    let b = 1;

    for (let n = 0; n < eccLength; n++) {
      let discrepancy = syndromes[n];
      for (let i = 1; i <= L; i++) {
        discrepancy ^= gfMul(lambda[i] || 0, syndromes[n - i]);
      }

      if (discrepancy === 0) {
        m++;
      } else {
        const scale = gfDiv(discrepancy, b);
        const updated = lambda.slice();
        for (let i = 0; i < prev.length; i++) {
          const idx = i + m;
          while (updated.length <= idx) updated.push(0);
          updated[idx] ^= gfMul(scale, prev[i]);
        }
        if (2 * L <= n) {
          const previousLambda = lambda;
          lambda = updated;
          L = n + 1 - L;
          prev = previousLambda;
          b = discrepancy;
          m = 1;
        } else {
          lambda = updated;
          m++;
        }
      }
    }

    const errorCount = lambda.length - 1;
    if (errorCount === 0 || errorCount * 2 > eccLength) return -1;

    // --- Chien search: the roots of lambda point at the bad codewords ---
    const positions = [];
    for (let i = 0; i < block.length; i++) {
      // Evaluate lambda at a^-i.
      const xInv = EXP[(255 - i) % 255];
      let sum = 0;
      let power = 1;
      for (let j = 0; j < lambda.length; j++) {
        sum ^= gfMul(lambda[j], power);
        power = gfMul(power, xInv);
      }
      if (sum === 0) positions.push(i);
    }
    if (positions.length !== errorCount) return -1;

    // --- Forney: work out how much each bad codeword is off by ---
    // omega(x) = syndromes(x) * lambda(x) mod x^eccLength
    const omega = new Array(eccLength).fill(0);
    for (let i = 0; i < eccLength; i++) {
      let sum = 0;
      for (let j = 0; j <= i && j < lambda.length; j++) {
        sum ^= gfMul(syndromes[i - j], lambda[j]);
      }
      omega[i] = sum;
    }

    for (const position of positions) {
      const xInv = EXP[(255 - position) % 255];

      let omegaValue = 0;
      let power = 1;
      for (let j = 0; j < eccLength; j++) {
        omegaValue ^= gfMul(omega[j], power);
        power = gfMul(power, xInv);
      }

      // Formal derivative of lambda: in GF(2) only the odd-degree terms live.
      let derivative = 0;
      power = 1;
      for (let j = 1; j < lambda.length; j += 2) {
        derivative ^= gfMul(lambda[j], power);
        power = gfMul(power, gfMul(xInv, xInv));
      }
      if (derivative === 0) return -1;

      // Position counts from the end of the block.
      const index = block.length - 1 - position;
      if (index < 0 || index >= block.length) return -1;
      // The encoder's generator starts at a^0, so the magnitude carries a
      // factor of the error locator X. Leaving it out scales every correction
      // by a^-position, which still finds the right codewords and then writes
      // the wrong bytes into them.
      const locator = EXP[position % 255];
      block[index] ^= gfMul(locator, gfDiv(omegaValue, derivative));
    }

    // Confirm the repair actually worked rather than trusting the algebra.
    for (let i = 0; i < eccLength; i++) {
      if (polyEvalDescending(block, EXP[i]) !== 0) return -1;
    }
    return positions.length;
  }

  // ------------------------------ Binarization ------------------------------

  /**
   * Adaptive threshold, block by block, so a code lit unevenly (a shadow
   * across one corner, glare on the other) still reads. Returns 1 for dark.
   *
   * The block needs to span more than one module to measure any local
   * contrast, so the caller varies `BLOCK` when a first pass finds nothing.
   */
  function binarize(gray, width, height, BLOCK) {
    BLOCK = BLOCK || 8;
    const bits = new Uint8Array(width * height);
    const subWidth = Math.max(1, Math.ceil(width / BLOCK));
    const subHeight = Math.max(1, Math.ceil(height / BLOCK));
    const blackPoints = new Int32Array(subWidth * subHeight);

    for (let by = 0; by < subHeight; by++) {
      for (let bx = 0; bx < subWidth; bx++) {
        const x0 = bx * BLOCK;
        const y0 = by * BLOCK;
        const x1 = Math.min(x0 + BLOCK, width);
        const y1 = Math.min(y0 + BLOCK, height);

        let min = 255;
        let max = 0;
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const v = gray[y * width + x];
            sum += v;
            count++;
            if (v < min) min = v;
            if (v > max) max = v;
          }
        }

        let average;
        if (max - min > 24) {
          average = sum / count;
        } else {
          // A flat block: assume it is all background unless its neighbours
          // suggest otherwise.
          average = min / 2;
          if (by > 0 && bx > 0) {
            const neighbours =
              (blackPoints[(by - 1) * subWidth + bx] +
                2 * blackPoints[by * subWidth + bx - 1] +
                blackPoints[(by - 1) * subWidth + bx - 1]) /
              4;
            if (min < neighbours) average = neighbours;
          }
        }
        blackPoints[by * subWidth + bx] = average;
      }
    }

    // Smooth the thresholds across neighbouring blocks to avoid hard seams.
    for (let by = 0; by < subHeight; by++) {
      for (let bx = 0; bx < subWidth; bx++) {
        const left = Math.min(Math.max(bx, 2), subWidth - 3);
        const top = Math.min(Math.max(by, 2), subHeight - 3);
        let sum = 0;
        let count = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = left + dx;
            const ny = top + dy;
            if (nx >= 0 && nx < subWidth && ny >= 0 && ny < subHeight) {
              sum += blackPoints[ny * subWidth + nx];
              count++;
            }
          }
        }
        const threshold = sum / count;

        const x0 = bx * BLOCK;
        const y0 = by * BLOCK;
        const x1 = Math.min(x0 + BLOCK, width);
        const y1 = Math.min(y0 + BLOCK, height);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            bits[y * width + x] = gray[y * width + x] <= threshold ? 1 : 0;
          }
        }
      }
    }

    return bits;
  }

  function toGrayscale(imageData) {
    const { data, width, height } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      // Rec. 601 luma, the usual weighting for this job.
      gray[i] = (data[p] * 306 + data[p + 1] * 601 + data[p + 2] * 117) >> 10;
    }
    return gray;
  }

  // ------------------------------ Finder patterns ------------------------------

  /** Does a run of five alternating lengths look like 1:1:3:1:1? */
  function isFinderRatio(counts) {
    let total = 0;
    for (let i = 0; i < 5; i++) {
      if (counts[i] === 0) return false;
      total += counts[i];
    }
    if (total < 7) return false;
    const module = total / 7;
    const tolerance = module / 2;
    return (
      Math.abs(module - counts[0]) < tolerance &&
      Math.abs(module - counts[1]) < tolerance &&
      Math.abs(3 * module - counts[2]) < 3 * tolerance &&
      Math.abs(module - counts[3]) < tolerance &&
      Math.abs(module - counts[4]) < tolerance
    );
  }

  /**
   * Walk a line of the image and return the centre of every 1:1:3:1:1 run.
   * `read(i)` returns 1 when the pixel at offset i along the line is dark.
   */
  function scanLine(read, length) {
    const hits = [];
    const counts = [0, 0, 0, 0, 0];
    let state = 0; // index into counts; even states are dark runs

    for (let i = 0; i < length; i++) {
      const dark = read(i) === 1;
      if (dark === (state % 2 === 0)) {
        counts[state]++;
      } else if (state === 4) {
        // A dark run ended while the window was full: test it.
        if (isFinderRatio(counts)) {
          hits.push({
            end: i,
            counts: counts.slice(),
          });
        }
        // Slide the window along by two runs and keep going.
        counts[0] = counts[2];
        counts[1] = counts[3];
        counts[2] = counts[4];
        counts[3] = 1;
        counts[4] = 0;
        state = 3;
      } else {
        state++;
        counts[state] = 1;
      }
    }
    if (state === 4 && isFinderRatio(counts)) {
      hits.push({ end: length, counts: counts.slice() });
    }
    return hits;
  }

  /** Centre of the middle run of a 1:1:3:1:1 hit that ended at `end`. */
  function centreOfHit(hit) {
    const c = hit.counts;
    const endOfMiddle = hit.end - c[4] - c[3];
    return endOfMiddle - c[2] / 2;
  }

  function findFinderPatterns(bits, width, height) {
    const candidates = [];
    const rowStep = Math.max(1, Math.floor(height / 256));

    for (let y = rowStep; y < height; y += rowStep) {
      const rowHits = scanLine((x) => bits[y * width + x], width);

      for (const hit of rowHits) {
        const centreX = centreOfHit(hit);
        const total = hit.counts.reduce((a, b) => a + b, 0);
        const moduleSize = total / 7;

        // Confirm the same pattern runs vertically through that point.
        const column = Math.round(centreX);
        if (column < 0 || column >= width) continue;
        const columnHits = scanLine((yy) => bits[yy * width + column], height);

        let best = null;
        for (const vertical of columnHits) {
          const centreY = centreOfHit(vertical);
          if (Math.abs(centreY - y) > total / 2) continue;
          const verticalModule = vertical.counts.reduce((a, b) => a + b, 0) / 7;
          // The two measurements of module size must roughly agree.
          if (
            Math.abs(verticalModule - moduleSize) >
            Math.max(verticalModule, moduleSize) / 2
          ) {
            continue;
          }
          best = { centreY, verticalModule };
          break;
        }
        if (!best) continue;

        const size = (moduleSize + best.verticalModule) / 2;
        const found = {
          x: centreX,
          y: best.centreY,
          moduleSize: size,
        };

        // Merge with an existing candidate if this is the same pattern seen
        // from another scan line.
        let merged = false;
        for (const existing of candidates) {
          if (
            Math.abs(existing.x - found.x) < existing.moduleSize * 2 &&
            Math.abs(existing.y - found.y) < existing.moduleSize * 2
          ) {
            existing.x = (existing.x * existing.count + found.x) / (existing.count + 1);
            existing.y = (existing.y * existing.count + found.y) / (existing.count + 1);
            existing.moduleSize =
              (existing.moduleSize * existing.count + found.moduleSize) /
              (existing.count + 1);
            existing.count++;
            merged = true;
            break;
          }
        }
        if (!merged) {
          found.count = 1;
          candidates.push(found);
        }
      }
    }

    // Patterns seen on only one scan line are usually noise.
    const solid = candidates.filter((c) => c.count >= 2);
    return (solid.length >= 3 ? solid : candidates).sort((a, b) => b.count - a.count);
  }

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /**
   * Work out which of three finder patterns is which. The corner opposite the
   * longest side is the top-left; the handedness of the remaining two tells us
   * which is top-right.
   */
  function orientPatterns(p) {
    const [a, b, c] = p;
    const ab = distance(a, b);
    const bc = distance(b, c);
    const ca = distance(c, a);

    let topLeft, other1, other2;
    if (bc >= ab && bc >= ca) {
      topLeft = a;
      other1 = b;
      other2 = c;
    } else if (ca >= ab && ca >= bc) {
      topLeft = b;
      other1 = a;
      other2 = c;
    } else {
      topLeft = c;
      other1 = a;
      other2 = b;
    }

    // Cross product decides which side of the diagonal each one sits on.
    // Image coordinates run y-downwards, so for an upright code with other1 at
    // the top right this comes out negative.
    const cross =
      (other2.x - topLeft.x) * (other1.y - topLeft.y) -
      (other2.y - topLeft.y) * (other1.x - topLeft.x);

    return cross < 0
      ? { topLeft, topRight: other1, bottomLeft: other2 }
      : { topLeft, topRight: other2, bottomLeft: other1 };
  }

  /** How many modules across is this code? */
  function estimateDimension(topLeft, topRight, bottomLeft, moduleSize) {
    const across = distance(topLeft, topRight) / moduleSize;
    const down = distance(topLeft, bottomLeft) / moduleSize;
    let dimension = Math.round((across + down) / 2) + 7;
    // Valid sizes are 21, 25, 29 ... so the result must be 1 mod 4.
    switch (dimension & 0x03) {
      case 0:
        dimension++;
        break;
      case 2:
        dimension--;
        break;
      case 3:
        return 0;
    }
    return dimension;
  }

  /**
   * Hunt for the alignment pattern near the bottom-right, which is what lets
   * us undo perspective rather than just rotation and scale.
   */
  /** Break a line of the image into runs of equal colour. */
  function runsAlongLine(read, from, to) {
    const runs = [];
    let start = from;
    let dark = read(from) === 1;
    for (let i = from + 1; i <= to; i++) {
      const here = read(i) === 1;
      if (here !== dark) {
        runs.push({ start, length: i - start, dark });
        start = i;
        dark = here;
      }
    }
    runs.push({ start, length: to + 1 - start, dark });
    return runs;
  }

  /**
   * Find a light-dark-light run whose middle is about one module wide, and
   * return the centre of that dark module.
   *
   * The centre row of an alignment pattern reads dark-light-dark-light-dark,
   * so the three modules through its middle are light-dark-light. Centring on
   * that middle dark run lands exactly on the pattern's centre.
   */
  function findCentreRuns(runs, moduleSize, contains) {
    const tolerance = Math.max(1, moduleSize * 0.6);
    const centres = [];
    for (let i = 0; i + 2 < runs.length; i++) {
      const a = runs[i];
      const b = runs[i + 1];
      const c = runs[i + 2];
      if (a.dark || !b.dark || c.dark) continue;
      if (Math.abs(b.length - moduleSize) > tolerance) continue;
      if (Math.abs(a.length - moduleSize) > tolerance) continue;
      if (Math.abs(c.length - moduleSize) > tolerance) continue;
      if (contains && !contains(b)) continue;
      centres.push(b.start + b.length / 2);
    }
    return centres;
  }

  function findAlignmentPattern(bits, width, height, estimateX, estimateY, moduleSize) {
    const radius = Math.ceil(moduleSize * 4);
    const left = Math.max(0, Math.floor(estimateX - radius));
    const right = Math.min(width - 1, Math.ceil(estimateX + radius));
    const top = Math.max(0, Math.floor(estimateY - radius));
    const bottom = Math.min(height - 1, Math.ceil(estimateY + radius));
    if (right - left < 3 || bottom - top < 3) return null;

    // Ordinary data modules throw up light-dark-light runs constantly, so
    // every candidate is collected and the one nearest the predicted centre
    // wins rather than simply the first one found.
    let best = null;
    for (let y = top; y <= bottom; y++) {
      const rowRuns = runsAlongLine((x) => bits[y * width + x], left, right);
      for (const centreX of findCentreRuns(rowRuns, moduleSize)) {
        // Confirm the same light-dark-light holds vertically through there.
        const column = Math.round(centreX);
        if (column < 0 || column >= width) continue;
        const columnRuns = runsAlongLine(
          (yy) => bits[yy * width + column],
          top,
          bottom
        );
        const verticalCentres = findCentreRuns(
          columnRuns,
          moduleSize,
          (run) => y >= run.start && y < run.start + run.length
        );
        if (!verticalCentres.length) continue;

        const centreY = verticalCentres[0];
        const dist = Math.hypot(centreX - estimateX, centreY - estimateY);
        if (!best || dist < best.dist) best = { x: centreX, y: centreY, dist };
      }
    }
    // A match several modules away from the prediction is some other part of
    // the code, not the alignment pattern.
    if (best && best.dist > moduleSize * 3) return null;
    return best;
  }

  // ------------------------------ Perspective ------------------------------

  /**
   * Build the transform that maps the unit square's corners onto an arbitrary
   * quadrilateral, then invert it, giving grid coordinates -> image pixels.
   */
  function squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3) {
    const dx3 = x0 - x1 + x2 - x3;
    const dy3 = y0 - y1 + y2 - y3;
    if (dx3 === 0 && dy3 === 0) {
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    }
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const denominator = dx1 * dy2 - dx2 * dy1;
    const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
    const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;
    return [
      x1 - x0 + a13 * x1,
      x3 - x0 + a23 * x3,
      x0,
      y1 - y0 + a13 * y1,
      y3 - y0 + a23 * y3,
      y0,
      a13,
      a23,
      1,
    ];
  }

  /**
   * Row-major 3x3 product. The nine coefficients are stored in the order
   * [a11, a21, a31, a12, a22, a32, a13, a23, a33], and every function here
   * agrees on that layout.
   */
  function multiply(a, b) {
    return [
      a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
      a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
      a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
      a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
      a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
      a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
      a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
      a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
      a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
    ];
  }

  function quadToSquare(x0, y0, x1, y1, x2, y2, x3, y3) {
    const s = squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3);
    // Adjugate, which serves as the inverse up to a scale factor that cancels.
    return [
      s[4] * s[8] - s[5] * s[7],
      s[2] * s[7] - s[1] * s[8],
      s[1] * s[5] - s[2] * s[4],
      s[5] * s[6] - s[3] * s[8],
      s[0] * s[8] - s[2] * s[6],
      s[2] * s[3] - s[0] * s[5],
      s[3] * s[7] - s[4] * s[6],
      s[1] * s[6] - s[0] * s[7],
      s[0] * s[4] - s[1] * s[3],
    ];
  }

  function transformPoint(t, x, y) {
    const denominator = t[6] * x + t[7] * y + t[8];
    return {
      x: (t[0] * x + t[1] * y + t[2]) / denominator,
      y: (t[3] * x + t[4] * y + t[5]) / denominator,
    };
  }

  /** Read the module grid out of the image using the fitted transform. */
  function sampleGrid(bits, width, height, transform, dimension) {
    const modules = [];
    for (let y = 0; y < dimension; y++) {
      const row = new Uint8Array(dimension);
      for (let x = 0; x < dimension; x++) {
        const p = transformPoint(transform, x + 0.5, y + 0.5);
        const px = Math.round(p.x);
        const py = Math.round(p.y);
        if (px < 0 || py < 0 || px >= width || py >= height) return null;
        row[x] = bits[py * width + px];
      }
      modules.push(row);
    }
    return modules;
  }

  // ------------------------------ Format information ------------------------------

  // Every legal 15-bit format string, so a damaged one can be matched to the
  // closest. Built with the same maths the encoder uses to write them.
  const FORMAT_TABLE = (function () {
    const table = [];
    const levels = ["L", "M", "Q", "H"];
    for (const ecl of levels) {
      for (let mask = 0; mask < 8; mask++) {
        const data = (spec.formatBits[ecl] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        table.push({ bits: (((data << 10) | rem) ^ 0x5412) & 0x7fff, ecl, mask });
      }
    }
    return table;
  })();

  function popcount(value) {
    let count = 0;
    while (value) {
      value &= value - 1;
      count++;
    }
    return count;
  }

  function decodeFormat(raw) {
    let best = null;
    for (const entry of FORMAT_TABLE) {
      const difference = popcount(raw ^ entry.bits);
      if (!best || difference < best.difference) {
        best = { ...entry, difference };
      }
    }
    // More than three wrong bits means we are not reading format bits at all.
    return best && best.difference <= 3 ? best : null;
  }

  function readFormatInformation(modules, dimension) {
    // The encoder places bit i of the format word at a known module, so read
    // each one back by index rather than shifting a running value. Note the
    // encoder's (x, y) is modules[y][x].
    const bit = (x, y) => modules[y][x];

    // Copy one, wrapped around the top-left finder.
    let first = 0;
    for (let i = 0; i <= 5; i++) first |= bit(8, i) << i;
    first |= bit(8, 7) << 6;
    first |= bit(8, 8) << 7;
    first |= bit(7, 8) << 8;
    for (let i = 9; i < 15; i++) first |= bit(14 - i, 8) << i;

    // Copy two, split between the other two corners.
    let second = 0;
    for (let i = 0; i < 8; i++) second |= bit(dimension - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) second |= bit(8, dimension - 15 + i) << i;

    // Both copies say the same thing; trust whichever reads more cleanly.
    const a = decodeFormat(first);
    const b = decodeFormat(second);
    if (!a) return b;
    if (!b) return a;
    return a.difference <= b.difference ? a : b;
  }

  // ------------------------------ Module extraction ------------------------------

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

  /** Mark every module that carries structure rather than data. */
  function buildFunctionMap(dimension, version) {
    const map = [];
    for (let i = 0; i < dimension; i++) map.push(new Uint8Array(dimension));

    const markRect = (x0, y0, w, h) => {
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          if (x >= 0 && y >= 0 && x < dimension && y < dimension) map[y][x] = 1;
        }
      }
    };

    // Finder patterns with their separators, and the format areas.
    markRect(0, 0, 9, 9);
    markRect(dimension - 8, 0, 8, 9);
    markRect(0, dimension - 8, 9, 8);

    // Timing patterns.
    for (let i = 0; i < dimension; i++) {
      map[6][i] = 1;
      map[i][6] = 1;
    }

    // Alignment patterns, skipping the three that overlap the finders.
    const positions = spec.alignmentPatternPositions(version);
    const count = positions.length;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const isCorner =
          (i === 0 && j === 0) ||
          (i === 0 && j === count - 1) ||
          (i === count - 1 && j === 0);
        if (!isCorner) markRect(positions[i] - 2, positions[j] - 2, 5, 5);
      }
    }

    // Version information blocks.
    if (version >= 7) {
      markRect(dimension - 11, 0, 3, 6);
      markRect(0, dimension - 11, 6, 3);
    }

    return map;
  }

  /** Undo the mask and read the codewords back out in the zig-zag order. */
  function extractCodewords(modules, dimension, version, mask) {
    const functionMap = buildFunctionMap(dimension, version);
    const maskFn = MASK_FUNCTIONS[mask];
    const total = Math.floor(spec.rawDataModules(version) / 8);
    const codewords = new Uint8Array(total);

    let bitIndex = 0;
    let current = 0;

    for (let right = dimension - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < dimension; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? dimension - 1 - vert : vert;
          if (functionMap[y][x]) continue;
          if (bitIndex >= total * 8) continue;

          let bit = modules[y][x];
          if (maskFn(x, y)) bit ^= 1;
          current = (current << 1) | bit;
          bitIndex++;
          if (bitIndex % 8 === 0) {
            codewords[bitIndex / 8 - 1] = current;
            current = 0;
          }
        }
      }
    }
    return codewords;
  }

  /**
   * Undo the interleaving the encoder applied, repair each block, and return
   * the data codewords joined back together.
   */
  function deinterleaveAndCorrect(codewords, version, ecl) {
    const numBlocks = spec.numEccBlocks[ecl][version];
    const eccPerBlock = spec.eccCodewordsPerBlock[ecl][version];
    const totalCodewords = Math.floor(spec.rawDataModules(version) / 8);
    const shortBlockCount = numBlocks - (totalCodewords % numBlocks);
    const shortBlockLength = Math.floor(totalCodewords / numBlocks);
    const shortDataLength = shortBlockLength - eccPerBlock;

    // Rebuild each block's data section.
    const blocks = [];
    for (let i = 0; i < numBlocks; i++) {
      blocks.push([]);
    }

    let index = 0;
    for (let i = 0; i < shortDataLength + 1; i++) {
      for (let j = 0; j < numBlocks; j++) {
        if (i === shortDataLength && j < shortBlockCount) continue;
        blocks[j].push(codewords[index++]);
      }
    }
    // Then the error correction section, which is the same length everywhere.
    const eccStart = index;
    for (let i = 0; i < eccPerBlock; i++) {
      for (let j = 0; j < numBlocks; j++) {
        blocks[j].push(codewords[eccStart + i * numBlocks + j]);
      }
    }

    let corrections = 0;
    const data = [];
    for (const block of blocks) {
      const buffer = Uint8Array.from(block);
      const result = reedSolomonDecode(buffer, eccPerBlock);
      if (result < 0) return null;
      corrections += result;
      for (let i = 0; i < buffer.length - eccPerBlock; i++) {
        data.push(buffer[i]);
      }
    }
    return { data, corrections };
  }

  // ------------------------------ Bitstream parsing ------------------------------

  const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

  function createBitReader(bytes) {
    let position = 0;
    return {
      remaining: () => bytes.length * 8 - position,
      read(count) {
        let value = 0;
        for (let i = 0; i < count; i++) {
          const byte = bytes[position >>> 3];
          const bit = (byte >>> (7 - (position & 7))) & 1;
          value = (value << 1) | bit;
          position++;
        }
        return value;
      },
    };
  }

  function countBits(mode, version) {
    const tier = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    switch (mode) {
      case 1:
        return [10, 12, 14][tier];
      case 2:
        return [9, 11, 13][tier];
      case 4:
        return [8, 16, 16][tier];
      case 8:
        return [8, 10, 12][tier];
      default:
        return 0;
    }
  }

  function decodeBytes(bytes, eci) {
    // ECI 3 is Latin-1; everything else in practice is UTF-8, which is also
    // the right guess when no ECI was declared at all.
    const encoding = eci === 3 ? "iso-8859-1" : "utf-8";
    try {
      return new TextDecoder(encoding).decode(Uint8Array.from(bytes));
    } catch (err) {
      return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
    }
  }

  function parseSegments(data, version) {
    const reader = createBitReader(data);
    let text = "";
    let eci = null;
    let pendingBytes = [];

    const flushBytes = () => {
      if (pendingBytes.length) {
        text += decodeBytes(pendingBytes, eci);
        pendingBytes = [];
      }
    };

    while (reader.remaining() >= 4) {
      const mode = reader.read(4);
      if (mode === 0) break; // terminator

      if (mode === 7) {
        // ECI: one to three bytes identifying the character set.
        flushBytes();
        const first = reader.read(8);
        if ((first & 0x80) === 0) eci = first;
        else if ((first & 0xc0) === 0x80) eci = ((first & 0x3f) << 8) | reader.read(8);
        else eci = ((first & 0x1f) << 16) | reader.read(16);
        continue;
      }

      const bits = countBits(mode, version);
      if (bits === 0) return null; // a mode we cannot read
      if (reader.remaining() < bits) break;
      const count = reader.read(bits);

      if (mode === 1) {
        flushBytes();
        let i = 0;
        for (; i + 3 <= count; i += 3) {
          if (reader.remaining() < 10) return null;
          text += String(reader.read(10)).padStart(3, "0");
        }
        if (count - i === 2) {
          if (reader.remaining() < 7) return null;
          text += String(reader.read(7)).padStart(2, "0");
        } else if (count - i === 1) {
          if (reader.remaining() < 4) return null;
          text += String(reader.read(4));
        }
      } else if (mode === 2) {
        flushBytes();
        let i = 0;
        for (; i + 2 <= count; i += 2) {
          if (reader.remaining() < 11) return null;
          const pair = reader.read(11);
          text += ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45];
        }
        if (count - i === 1) {
          if (reader.remaining() < 6) return null;
          text += ALPHANUMERIC[reader.read(6)];
        }
      } else if (mode === 4) {
        if (reader.remaining() < count * 8) return null;
        for (let i = 0; i < count; i++) pendingBytes.push(reader.read(8));
      } else if (mode === 8) {
        // Kanji, stored as Shift-JIS pairs.
        flushBytes();
        const sjis = [];
        for (let i = 0; i < count; i++) {
          if (reader.remaining() < 13) return null;
          const value = reader.read(13);
          let assembled = (Math.floor(value / 0xc0) << 8) | value % 0xc0;
          assembled += assembled < 0x1f00 ? 0x8140 : 0xc140;
          sjis.push(assembled >> 8, assembled & 0xff);
        }
        try {
          text += new TextDecoder("shift-jis").decode(Uint8Array.from(sjis));
        } catch (err) {
          return null; // this browser cannot decode Shift-JIS
        }
      } else {
        return null; // structured append and friends
      }
    }

    flushBytes();
    return text;
  }

  // ------------------------------ Top level ------------------------------

  /** Try to read a code out of an already-binarized image. */
  function decodeBits(bits, width, height) {
    const patterns = findFinderPatterns(bits, width, height);
    if (patterns.length < 3) return null;

    // Try the most convincing combinations of three.
    const limit = Math.min(patterns.length, 5);
    for (let a = 0; a < limit - 2; a++) {
      for (let b = a + 1; b < limit - 1; b++) {
        for (let c = b + 1; c < limit; c++) {
          const result = tryPatterns(bits, width, height, [
            patterns[a],
            patterns[b],
            patterns[c],
          ]);
          if (result) return result;
        }
      }
    }
    return null;
  }

  function tryPatterns(bits, width, height, three) {
    const { topLeft, topRight, bottomLeft } = orientPatterns(three);
    const moduleSize =
      (topLeft.moduleSize + topRight.moduleSize + bottomLeft.moduleSize) / 3;
    if (!(moduleSize > 0)) return null;

    const estimated = estimateDimension(topLeft, topRight, bottomLeft, moduleSize);
    if (!estimated) return null;

    // Module size is measured from three small patterns, so on a dense code
    // a fraction of a pixel of error is enough to land a whole version out.
    // Try the neighbouring sizes too: a wrong guess cannot produce a false
    // reading, because Reed-Solomon rejects it.
    for (const dimension of [estimated, estimated - 4, estimated + 4, estimated - 8, estimated + 8]) {
      if (dimension < 21 || dimension > 177) continue;
      const result = attemptDimension(
        bits,
        width,
        height,
        topLeft,
        topRight,
        bottomLeft,
        moduleSize,
        dimension
      );
      if (result) return result;
    }
    return null;
  }

  function attemptDimension(
    bits,
    width,
    height,
    topLeft,
    topRight,
    bottomLeft,
    moduleSize,
    dimension
  ) {
    const version = (dimension - 17) / 4;
    if (!Number.isInteger(version) || version < 1 || version > 40) return null;

    // The fourth reference point: the alignment pattern if we can find it,
    // otherwise the implied far corner, which assumes no perspective.
    let bottomRightX = topRight.x + bottomLeft.x - topLeft.x;
    let bottomRightY = topRight.y + bottomLeft.y - topLeft.y;
    let sourceBottomRight = dimension - 3.5;
    let alignment = null;

    if (version >= 2) {
      const correction = 1 - 3 / (dimension - 7);
      const estimateX = topLeft.x + correction * (bottomRightX - topLeft.x);
      const estimateY = topLeft.y + correction * (bottomRightY - topLeft.y);
      alignment = findAlignmentPattern(
        bits,
        width,
        height,
        estimateX,
        estimateY,
        moduleSize
      );
      if (alignment) {
        bottomRightX = alignment.x;
        bottomRightY = alignment.y;
        sourceBottomRight = dimension - 6.5;
      }
    }

    // Grid coordinates go through the unit square and out into image pixels,
    // so the image transform is applied second and therefore comes first here.
    const transform = multiply(
      squareToQuad(
        topLeft.x,
        topLeft.y,
        topRight.x,
        topRight.y,
        bottomRightX,
        bottomRightY,
        bottomLeft.x,
        bottomLeft.y
      ),
      quadToSquare(
        3.5,
        3.5,
        dimension - 3.5,
        3.5,
        sourceBottomRight,
        sourceBottomRight,
        3.5,
        dimension - 3.5
      )
    );

    const modules = sampleGrid(bits, width, height, transform, dimension);
    if (!modules) return null;

    const format = readFormatInformation(modules, dimension);
    if (!format) return null;

    const codewords = extractCodewords(modules, dimension, version, format.mask);
    const corrected = deinterleaveAndCorrect(codewords, version, format.ecl);
    if (!corrected) return null;

    const text = parseSegments(corrected.data, version);
    if (text === null) return null;

    return {
      text,
      version,
      ecl: format.ecl,
      mask: format.mask,
      corrections: corrected.corrections,
    };
  }

  /**
   * Read a QR code from an ImageData. Returns null when none is found, which
   * is the normal case for most camera frames.
   */
  function decode(imageData, options) {
    const { width, height } = imageData;
    if (!width || !height) return null;
    const gray = toGrayscale(imageData);

    // The right threshold block depends on how large the modules happen to be
    // in this frame, which is not known until something decodes. Work through
    // a few sizes rather than giving up on the first. A live camera gets many
    // frames a second, so it passes a shorter ladder and relies on the next
    // frame; a single uploaded photo is worth the full effort.
    const ladder = (options && options.blockSizes) || [8, 16, 4, 24];
    for (const block of ladder) {
      const bits = binarize(gray, width, height, block);

      const result = decodeBits(bits, width, height);
      if (result) return result;

      // A light code on a dark background is a legitimate QR code that
      // scanners are allowed to reject, but since this page exists to say what
      // a code contains, try the inverse before moving on.
      const inverted = new Uint8Array(bits.length);
      for (let i = 0; i < bits.length; i++) inverted[i] = bits[i] ^ 1;
      const invertedResult = decodeBits(inverted, width, height);
      if (invertedResult) {
        invertedResult.inverted = true;
        return invertedResult;
      }
    }
    return null;
  }

  return {
    decode,
    // Exposed for the test suite, which checks each stage of the pipeline
    // separately rather than only the end result.
    _internals: {
      reedSolomonDecode,
      binarize,
      toGrayscale,
      decodeBits,
      findFinderPatterns,
      findAlignmentPattern,
      orientPatterns,
      estimateDimension,
      sampleGrid,
      readFormatInformation,
      extractCodewords,
      deinterleaveAndCorrect,
      parseSegments,
      squareToQuad,
      quadToSquare,
      multiply,
    },
  };
})();
