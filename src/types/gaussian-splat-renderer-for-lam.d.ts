// LAM's WebGL renderer ships no type declarations. Only what the app uses
// is described here (see src/components/HeadAvatar.tsx).
declare module "gaussian-splat-renderer-for-lam" {
  export class GaussianSplatRenderer {
    static instance?: GaussianSplatRenderer;
    static getInstance(
      container: HTMLDivElement,
      assetPath: string,
      options?: {
        // "Idle", "Listening", "Thinking" or "Responding".
        getChatState?: () => string;
        // The weight (0 to 1) of each ARKit face shape, by name.
        getExpressionData?: () => Record<string, number>;
        // "0xrrggbb"
        backgroundColor?: string;
        alpha?: number;
      }
    ): Promise<GaussianSplatRenderer>;
    dispose(): void;
    // The scene viewer inside: its camera, and the mouse controls if any.
    viewer?: {
      camera?: {
        fov: number;
        updateProjectionMatrix: () => void;
        setViewOffset: (
          fullWidth: number,
          fullHeight: number,
          x: number,
          y: number,
          width: number,
          height: number
        ) => void;
      } | null;
      controls?: { enabled: boolean; stopListenToKeyEvents?: () => void } | null;
      // 0 = default, 1 = gradual, 2 = at once.
      sceneRevealMode?: number;
    };
  }
}
