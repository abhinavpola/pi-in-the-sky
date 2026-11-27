declare global {
  interface WebSocketConstructor {
    new (
      url: string,
      protocols?: string | string[] | null,
      options?: { headers?: Record<string, string> },
    ): WebSocket;
  }

  var WebSocket: WebSocketConstructor;
}

export {};
