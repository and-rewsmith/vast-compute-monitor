import type { PointerEvent } from "react";

// Convert a pointer event into the SVG's own coordinate space.
//
// This is not the identity function, because `.app` carries `zoom: 0.9` (the
// dashboard's density scale). `getBoundingClientRect()` reports the *rendered*
// box -- already multiplied by the zoom -- while the SVG's internal geometry is
// laid out in unzoomed pixels taken from `clientWidth`. Subtracting rect.left
// from clientX therefore yields a value ~10% short, and the crosshair lands
// left of the pointer by a distance that grows across the chart. Dividing by
// the measured scale corrects it for any zoom or transform, without either
// value having to be known here.
export function localX(e: PointerEvent<SVGSVGElement>, layoutWidth: number): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const scale = rect.width > 0 ? rect.width / layoutWidth : 1;
  return (e.clientX - rect.left) / (scale || 1);
}
