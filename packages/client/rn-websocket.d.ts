declare global {
  interface WebSocketConstructor {
    new (
      url: string,
      protocols?: string | string[] | null,
      options?: { headers?: Record<string, string> },
    ): WebSocket;
  }

  var WebSocket: WebSocketConstructor;
  var crypto: {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
    subtle: {
      digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>;
    };
  };
  var TextEncoder: {
    new (): { encode(input?: string): Uint8Array<ArrayBuffer> };
  };
}

export {};
