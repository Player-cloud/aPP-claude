import assert from 'node:assert/strict';
import test from 'node:test';
import { averageLook, readLook } from '../src/shared/look.ts';

/** A width × height picture filled by a function of x and y. */
function picture(width: number, height: number, at: (x: number, y: number) => [number, number, number, number?]): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = at(x, y);
      out.push(r, g, b, a);
    }
  return out;
}

test('M18-8: a plain white picture is light, plain, calm and airy, with one colour', () => {
  const look = readLook(picture(10, 10, () => [255, 255, 255]), 10, 10);
  assert.deepEqual(look, { palette: ['#FFFFFF'], light: 1, rich: 0, loud: 0, dense: 0 });
});

test('M18-8: black and white stripes are loud and dense; a saturated colour is rich', () => {
  const stripes = readLook(picture(10, 10, (x) => (x % 2 ? [0, 0, 0] : [255, 255, 255])), 10, 10);
  assert.deepEqual(stripes.palette, ['#FFFFFF', '#000000']);
  assert.equal(stripes.loud, 1);
  assert.equal(stripes.dense, 1);
  assert.equal(stripes.light, 0.5);
  const red = readLook(picture(4, 4, () => [230, 20, 20]), 4, 4);
  assert.ok(red.rich > 0.8, String(red.rich));
  assert.deepEqual(red.palette, ['#E61414']);
});

test('M18-8: the palette keeps distinct main colours, lightest first, and skips transparent pixels', () => {
  // 60% light grey, 30% blue, 10% a near-identical blue, and a transparent corner.
  const look = readLook(
    picture(10, 10, (x, y) => (y === 0 && x === 0 ? [255, 0, 0, 0] : y < 6 ? [240, 240, 240] : y < 9 ? [40, 90, 220] : [44, 94, 224])),
    10,
    10,
  );
  assert.deepEqual(look.palette, ['#F0F0F0', '#285ADC']);
  assert.equal(readLook([], 0, 0).palette.length, 0);
  assert.deepEqual(averageLook([look, { ...look, light: 0 }])!.light, look.light / 2);
  assert.equal(averageLook([]), null);
});
