export interface LineCommandMetrics {
  steps: number;
  stride: number;
  hopCount: number;
  actionCount: number;
  drawCount: number;
  usesDiscreteStride: boolean;
}

export function getLineCommandMetrics(
  dx: number,
  dy: number,
  stride = 1,
): LineCommandMetrics {
  const steps = Math.abs(dx) + Math.abs(dy);
  const normalizedStride =
    Number.isFinite(stride) && stride > 0 ? Math.max(1, Math.trunc(stride)) : 1;

  if (normalizedStride > 1 && steps > 0 && steps % normalizedStride === 0) {
    const hopCount = steps / normalizedStride;

    return {
      steps,
      stride: normalizedStride,
      hopCount,
      actionCount: 1 + steps + hopCount,
      drawCount: 1 + hopCount,
      usesDiscreteStride: true,
    };
  }

  return {
    steps,
    stride: normalizedStride,
    hopCount: steps,
    actionCount: steps + 1,
    drawCount: steps + 1,
    usesDiscreteStride: false,
  };
}
