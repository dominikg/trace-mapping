import { memoizedBinarySearch } from './binary-search';

import type { SourceMap } from './source-map';
import type { SourceMapSegment, DecodedSourceMap, EncodedSourceMap } from './types';

const ITEM_LENGTH = 5;

export class EncodedSourceMapImpl implements SourceMap {
  _lastIndex = 0;
  _lastLine = 0;
  _lastColumn = 0;

  private _lineIndices: number[] = [];
  private declare _encoded: string;
  private declare _mappings: Uint32Array;

  constructor(map: EncodedSourceMap) {
    this._encoded = map.mappings;
    this._mappings = decode(this._encoded, this._lineIndices);
  }

  encodedMappings(): EncodedSourceMap['mappings'] {
    return this._encoded;
  }

  decodedMappings(): DecodedSourceMap['mappings'] {
    const { _mappings: mappings, _lineIndices: lineIndices } = this;
    const decoded: SourceMapSegment[][] = [];
    let line: SourceMapSegment[] = [];

    let lineIndicesIndex = 1;
    let lineIndex = lineIndices[lineIndicesIndex];

    for (let i = 0; i < mappings.length; i += ITEM_LENGTH) {
      while (i === lineIndex) {
        lineIndex = lineIndices[++lineIndicesIndex];
        decoded.push(line);
        line = [];
      }
      line.push(segmentify(mappings, i));
    }
    decoded.push(line);
    return decoded;
  }

  traceSegment(line: number, column: number): SourceMapSegment | null {
    const { _mappings: mappings, _lineIndices: lineIndices } = this;

    // It's common for parent source maps to have pointers to lines that have no
    // mapping (like a "//# sourceMappingURL=") at the end of the child file.
    if (line >= lineIndices.length - 1) return null;

    const index = memoizedBinarySearch(
      mappings,
      column,
      searchComparator,
      lineIndices[line],
      lineIndices[line + 1] - 1,
      ITEM_LENGTH,
      this,
      line,
      column,
    );

    // we come before any mapped segment
    if (index < 0) return null;
    return segmentify(mappings, index);
  }
}

function decode(encoded: string, lines: number[]): Uint32Array {
  lines.push(0);
  let generatedColumn = 0;
  // 0 is used as a "not found" marker, so these start at 1.
  let sourcesIndex = 1;
  let sourceLine = 1;
  let sourceColumn = 1;
  let namesIndex = 1;

  let decoded = new Uint32Array(1000);
  let lastLineStart = 0;

  let count = 0;
  for (let pos = 0; pos < encoded.length; ) {
    switch (encoded.charCodeAt(pos)) {
      case 44: // ','
        pos++;
        continue;

      case 59: // ';'
        generatedColumn = 0;
        lines.push(count);
        maybeSort(decoded, lastLineStart, count);
        lastLineStart = count;
        pos++;
        continue;

      default:
        decoded = reserve(decoded, count, ITEM_LENGTH);
        pos = decodeInteger(encoded, pos, decoded, count);
        generatedColumn = decoded[count++] += generatedColumn;

        if (!hasMoreMappings(encoded, pos)) {
          count += 4;
          continue;
        }

        pos = decodeInteger(encoded, pos, decoded, count);
        sourcesIndex = decoded[count++] += sourcesIndex;
        pos = decodeInteger(encoded, pos, decoded, count);
        sourceLine = decoded[count++] += sourceLine;
        pos = decodeInteger(encoded, pos, decoded, count);
        sourceColumn = decoded[count++] += sourceColumn;

        if (!hasMoreMappings(encoded, pos)) {
          count += 1;
          continue;
        }

        pos = decodeInteger(encoded, pos, decoded, count);
        namesIndex = decoded[count++] += namesIndex;
    }
  }
  lines.push(count);
  maybeSort(decoded, lastLineStart, count);
  return decoded.subarray(0, count);
}

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const base64Index = new Uint8Array(128);
for (let i = 0; i < base64.length; i++) {
  base64Index[base64.charCodeAt(i)] = i;
}

function reserve(buf: Uint32Array, pos: number, count: number): Uint32Array {
  if (buf.length > pos + count) return buf;

  const swap = new Uint32Array(buf.length * 2);
  swap.set(buf);
  return swap;
}

function hasMoreMappings(encoded: string, pos: number): boolean {
  if (pos === encoded.length) return false;
  const c = encoded.charCodeAt(pos);
  return c !== 44 /* ',' */ && c !== 59 /* ';' */;
}

function decodeInteger(encoded: string, pos: number, state: Uint32Array, index: number): number {
  let value = 0;
  let shift = 0;
  let integer = 0;

  do {
    const c = encoded.charCodeAt(pos++);
    integer = base64Index[c];
    value |= (integer & 31) << shift;
    shift += 5;
  } while (integer & 32);

  const shouldNegate = value & 1;
  value >>>= 1;

  if (shouldNegate) value = -0x80000000 | -value;

  state[index] = value;
  return pos;
}

function segmentify(mappings: Uint32Array, i: number): SourceMapSegment {
  if (mappings[i + 1] === 0) return [mappings[i]];

  if (mappings[i + 4] === 0) {
    return [mappings[i], mappings[i + 1] - 1, mappings[i + 2] - 1, mappings[i + 3] - 1];
  }

  return [
    mappings[i],
    mappings[i + 1] - 1,
    mappings[i + 2] - 1,
    mappings[i + 3] - 1,
    mappings[i + 4] - 1,
  ];
}

function maybeSort(state: Uint32Array, start: number, end: number) {
  if (isSorted(state, start, end)) return;
  const segments = [];
  for (let i = start; i < end; i += ITEM_LENGTH) {
    segments.push(state.slice(start, start + ITEM_LENGTH));
  }

  segments.sort(sortComparator);
  for (let i = 0; i < segments.length; i++) {
    state.set(segments[i], start + i * ITEM_LENGTH);
  }
}

function isSorted(state: Uint32Array, start: number, end: number): boolean {
  for (let i = start + ITEM_LENGTH; i < end; i += ITEM_LENGTH) {
    if (state[i] < state[i - ITEM_LENGTH]) return false;
  }
  return true;
}

function sortComparator(a: Uint32Array, b: Uint32Array): number {
  return a[0] - b[0];
}

function searchComparator(column: number, needle: number): number {
  return column - needle;
}
