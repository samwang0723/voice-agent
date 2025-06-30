import logger from '../logger';

/**
 * Monkey-patch WebSocket for Cartesia compatibility with Bun
 *
 * Cartesia SDK expects WebSocket binaryType to support 'blob',
 * but Bun only supports 'arraybuffer'. This patch intercepts
 * and converts 'blob' to 'arraybuffer' automatically.
 */
export function applyWebSocketPatches(): void {
  try {
    const wsPrototype = global.WebSocket.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(
      wsPrototype,
      'binaryType'
    );

    if (descriptor && descriptor.set) {
      const originalSetter = descriptor.set;
      Object.defineProperty(wsPrototype, 'binaryType', {
        ...descriptor,
        set(type: string) {
          if (type === 'blob') {
            logger.warn(
              "Monkey-patch: Intercepted WebSocket binaryType 'blob', changing to 'arraybuffer' for Bun compatibility."
            );
            originalSetter.call(this, 'arraybuffer');
          } else {
            originalSetter.call(this, type);
          }
        },
      });
      logger.info('Applied WebSocket binaryType monkey-patch for Cartesia.');
    } else {
      logger.warn(
        'Could not apply WebSocket binaryType monkey-patch: descriptor not found.'
      );
    }
  } catch (error) {
    logger.error('Failed to apply WebSocket binaryType monkey-patch:', error);
  }
}
