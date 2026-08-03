/** Minimal type surface for onnxruntime-node used by the AI worker. */
declare module 'onnxruntime-node' {
  export interface InferenceSession {
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }

  export interface InferenceSessionOptions {
    executionMode?: 'sequential' | 'parallel';
    graphOptimizationLevel?: string;
  }

  export const InferenceSession: {
    create(
      path: string,
      options?: InferenceSessionOptions,
    ): Promise<InferenceSession>;
  };

  export class Tensor {
    constructor(
      type: 'float32',
      data: Float32Array,
      dims: readonly number[],
    );
    readonly data: Float32Array;
    readonly dims: readonly number[];
  }
}
